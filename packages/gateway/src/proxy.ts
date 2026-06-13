/**
 * Core proxy: forward a client request to the upstream Anthropic API and
 * stream the response back.
 *
 * ── Phase 1 (this file, for now): PURE PASS-THROUGH ──────────────────
 * The request body is buffered and forwarded byte-intact; the response
 * stream is piped back unchanged. This isolates "does the proxy plumbing
 * work" from the swap/rehydrate logic added in Phases 2 and 3.
 *
 * Two seams are reserved for later phases and marked inline:
 *   • REQUEST SEAM  — rewrite outbound user text (real → mock) before
 *                     forwarding. Added in Phase 2.
 *   • RESPONSE SEAM — rewrite the streamed response (mock → real) with
 *                     token-boundary buffering. Added in Phase 3.
 *
 * Auth is RELAYED, never replaced: x-api-key / authorization /
 * anthropic-version / anthropic-beta flow straight through (see
 * buildUpstreamHeaders, which strips only hop-by-hop headers).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";
import type { SqlMaskHandle } from "./sql-mask.js";
import type { ProviderAdapter } from "./adapters/types.js";
import { runDetectorSwap } from "./swap-request.js";
import {
  buildClientHeaders,
  buildUpstreamHeaders,
  readBody,
} from "./http-util.js";

export interface ProxyContext {
  config: GatewayConfig;
  log: Logger;
  /** Path portion of the request, e.g. "/v1/messages". */
  path: string;
  /** Session-scoped real↔mock store (in-memory, never persisted). */
  store: SessionStore;
  /**
   * Whether this path carries user text we should scan/mask and whose response
   * we should rehydrate. False for opaque/forwarded paths.
   */
  inspect: boolean;
  /** Wire-format adapter for this request (Anthropic / OpenAI). */
  adapter: ProviderAdapter;
  /** Upstream origin to forward to for this request's provider. */
  upstreamBaseUrl: string;
  /**
   * Optional SQL-masking handle. When present and enabled, outbound SQL is
   * masked before the detector swap. Null when maskSql is off or the worker
   * couldn't start (detector swap still runs).
   */
  sqlMask: SqlMaskHandle | null;
}

/**
 * Forward one request to upstream and stream the reply back to `res`.
 */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): Promise<void> {
  const { config, log, path, store, inspect, sqlMask, adapter, upstreamBaseUrl } = ctx;
  const started = Date.now();

  // 1. Buffer the request body.
  const reqBody = await readBody(req);

  // ── REQUEST SEAM (Phase 2): real → mock swap on user text only ──────
  // For Messages-format paths we parse the body, swap secrets out of the
  // text content (never tool blocks / structure), and forward the
  // rewritten bytes. For all other paths we forward untouched.
  let outboundBody = reqBody;
  if (inspect) {
    // SQL-masking pass (optional): mask proprietary identifiers + scrub
    // sensitive literals in any SQL, BEFORE the detector swap runs. Mappings
    // are folded into the same store, so the response rehydrates them too.
    let bodyForSwap = reqBody;
    if (sqlMask) {
      const sqlOutcome = await sqlMask.maskBody(adapter, reqBody, store);
      bodyForSwap = sqlOutcome.body;
      if (sqlOutcome.blocks > 0) {
        log.debug(
          `sql-mask: ${sqlOutcome.blocks} SQL block(s), ` +
            `${sqlOutcome.masked} identifier/value(s) masked in ${path}`,
        );
      }
    }

    const outcome = await runDetectorSwap(adapter, bodyForSwap, config, store);

    if (outcome.detected > 0) {
      // Metadata-only logging (gated by WYLOC_VERBOSE / DEBUG). NEVER logs
      // a secret value or a mock↔real mapping — only coarse types, counts,
      // and the leak boolean computed locally.
      log.debug(
        `detection: ${outcome.detected} secret(s) in ${path} ` +
          `[types: ${dedupe(outcome.types).join(", ")}]`,
      );

      if (config.onDetect === "block") {
        log.debug(`policy=block → rejecting request to ${path}, not forwarding`);
        sendGatewayError(
          res,
          403,
          `Blocked: ${outcome.detected} secret(s) detected in prompt ` +
            `(policy onDetect=block).`,
        );
        return;
      }

      log.debug(
        `swap: ${outcome.swapCount} placeholder(s) written; ` +
          `WYLOC_MOCK_ count in upstream body=${outcome.mockCount}; ` +
          `real secret survived swap in rewritten text: ${outcome.leaked ? "YES — LEAK!" : "no"}; ` +
          `system directive injected: ${outcome.injected ? "yes" : "no"}`,
      );
      if (outcome.leaked) {
        log.error(
          `swap leak guard tripped for ${path}: a real secret survived the swap in text we rewrote`,
        );
      }
    }

    outboundBody = outcome.body;
  }

  // 2. Forward to upstream with the caller's own credentials/headers.
  const upstreamUrl = `${upstreamBaseUrl}${path}`;
  const headers = buildUpstreamHeaders(req.headers);

  const method = req.method ?? "POST";
  // GET/HEAD must not carry a body; everything else forwards bytes.
  const sendsBody =
    method !== "GET" && method !== "HEAD" && outboundBody.length > 0;
  const init: RequestInit = {
    method,
    headers,
    // We handle redirects ourselves rather than silently following.
    redirect: "manual",
  };
  if (sendsBody) {
    // Buffer is a Uint8Array, a valid BodyInit.
    init.body = new Uint8Array(outboundBody);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (err) {
    log.error(`upstream fetch failed for ${path}`, err);
    sendGatewayError(res, 502, "Failed to reach upstream Anthropic API.");
    return;
  }

  // 3. Mirror upstream status + headers back to the client.
  res.writeHead(upstream.status, buildClientHeaders(upstream.headers));

  // 4. Stream the body back.
  if (!upstream.body) {
    res.end();
    log.debug(
      `${req.method} ${path} -> ${upstream.status} (${Date.now() - started}ms, no body)`,
    );
    return;
  }

  // ── RESPONSE SEAM (Phase 3): mock → real rehydration ───────────────
  // Rehydrate only SSE responses on inspected paths when we actually hold
  // mappings. The token-boundary transform preserves framing and streams
  // progressively (it holds back at most a partial mock token, never the
  // whole response). All other responses pass through byte-for-byte.
  const contentType = upstream.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  const rehydrate = inspect && isEventStream && store.size > 0;
  const upstreamBody = upstream.body as AsyncIterable<Uint8Array>;
  const outStream = rehydrate
    ? adapter.rehydrateResponse(upstreamBody, store.all())
    : upstreamBody;
  if (rehydrate) log.debug(`rehydrating SSE response for ${path}`);

  try {
    for await (const chunk of outStream) {
      // Respect backpressure: stop reading if the client buffer is full.
      const ok = res.write(chunk);
      if (!ok) await once(res, "drain");
    }
    res.end();
  } catch (err) {
    log.error(`stream relay failed for ${path}`, err);
    // Headers are already sent; all we can do is end the stream.
    res.end();
  }

  log.debug(
    `${req.method} ${path} -> ${upstream.status} (${Date.now() - started}ms)`,
  );
}

/** Distinct values, order-preserving — for compact type lists in logs. */
function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Resolve once an EventEmitter fires `event` (used for stream drain). */
function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

/** Emit a gateway-originated error in Anthropic's error envelope shape. */
export function sendGatewayError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  const body = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `[wyloc-gateway] ${message}` },
  });
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(body);
}
