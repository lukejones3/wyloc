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
import type { CodeMaskHandle } from "./code-mask.js";
import type { FileReadMaskHandle } from "./mask-file-reads.js";
import type { EnvMaskHandle } from "./env-mask.js";
import type { MaskCache } from "./mask-cache.js";
import type { ProviderAdapter } from "./adapters/types.js";
import { applyDetectorSwap } from "./swap-request.js";
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
  /**
   * Optional TS/JS code-masking handle. When present and enabled, proprietary
   * identifiers + internal infra in fenced code blocks are masked before the
   * detector swap. Null when maskCode is off. Pure in-process (no worker).
   */
  codeMask: CodeMaskHandle | null;
  /**
   * Optional file-read masking handle. When present and enabled, the text of
   * tool results (files the agent read) is masked — detector always, SQL/code
   * per their toggles — before the message-text detector swap. Null when
   * maskFileReads is off.
   */
  fileReadMask: FileReadMaskHandle | null;
  /**
   * Optional env-masking handle. When present and enabled, env content the user
   * typed/pasted (a fenced env block, or a whole-message .env) has its values
   * masked before the detector swap. Null when maskEnv is off. (Files an agent
   * reads are handled by the file-read content-router, not here.)
   */
  envMask: EnvMaskHandle | null;
  /** Per-session cache for the message-text detector swap (re-sent history → hit). */
  detectorCache: MaskCache;
}

/**
 * Forward one request to upstream and stream the reply back to `res`.
 */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): Promise<void> {
  const { config, log, path, store, inspect, sqlMask, codeMask, fileReadMask, envMask, detectorCache, adapter, upstreamBaseUrl } = ctx;
  const started = Date.now();
  let maskMs = 0; // time spent in request masking (separate from upstream latency)

  // 1. Buffer the request body.
  const reqBody = await readBody(req);

  // ── REQUEST SEAM: real → mock masking on user text only ──────────────
  // PARSE-ONCE pipeline: parse the body ONCE, run every pass on the shared
  // parsed object (each masks the prior's output, preserving the chaining
  // semantics — detector runs on SQL/code/env-masked text), inject the directive
  // once, and serialize ONCE. Tool-call structure is never touched. Non-JSON or
  // non-object bodies forward untouched.
  let outboundBody = reqBody;
  if (inspect && reqBody.length > 0) {
    const maskStart = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(reqBody.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === "object") {
      let mutated = false; // did ANY pass change the object? (else forward original bytes)
      if (sqlMask) {
        const r = await sqlMask.applyToParsed(adapter, parsed, store);
        if (r.blocks > 0) { mutated = true; log.debug(`sql-mask: ${r.blocks} SQL block(s), ${r.masked} masked in ${path}`); }
      }
      if (codeMask) {
        const r = await codeMask.applyToParsed(adapter, parsed, store);
        if (r.blocks > 0) { mutated = true; log.debug(`code-mask: ${r.blocks} TS/JS block(s), ${r.masked} masked in ${path}`); }
      }
      if (envMask) {
        const r = await envMask.applyToParsed(adapter, parsed, store);
        if (r.blocks > 0) { mutated = true; log.debug(`env-mask: ${r.blocks} env block(s), ${r.masked} value(s) masked in ${path}`); }
      }
      let fileReadSecretMock = false;
      if (fileReadMask) {
        const r = await fileReadMask.applyToParsed(adapter, parsed, store);
        fileReadSecretMock = r.hasSecretMock;
        if (r.files > 0) { mutated = true; log.debug(`file-read-mask: ${r.files} tool-result(s), ${r.masked} masked in ${path}`); }
      }

      // Detector swap runs LAST, on the SQL/code/env/file-read-masked object.
      const det = await applyDetectorSwap(adapter, parsed, config, store, detectorCache);
      if (det.detected > 0) {
        mutated = true;
        log.debug(`detection: ${det.detected} secret(s) in ${path} [types: ${dedupe(det.types).join(", ")}]`);
        if (config.onDetect === "block") {
          log.debug(`policy=block → rejecting request to ${path}, not forwarding`);
          sendGatewayError(res, 403, `Blocked: ${det.detected} secret(s) detected in prompt (policy onDetect=block).`);
          return;
        }
        if (det.leaked) log.error(`swap leak guard tripped for ${path}: a real secret survived the swap`);
      }

      // Inject the verbatim-echo directive ONCE if any mock was produced this
      // turn (message-text secret OR a file-read secret), so it round-trips.
      let injected = false;
      if ((det.detected > 0 || fileReadSecretMock) && config.injectSystemPrompt) {
        adapter.injectDirective(parsed);
        injected = true;
        mutated = true;
      }

      // SERIALIZE ONCE — but only if a pass changed the object; otherwise
      // forward the ORIGINAL bytes (byte-identical to a no-op request).
      outboundBody = mutated ? Buffer.from(JSON.stringify(parsed), "utf8") : reqBody;
      if (det.detected > 0) {
        log.debug(`swap: ${det.swapCount} placeholder(s); directive injected: ${injected ? "yes" : "no"}`);
      }
    }
    maskMs = Date.now() - maskStart;
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
      `${req.method} ${path} -> ${upstream.status} (${Date.now() - started}ms total, masking ${maskMs}ms, no body)`,
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
    // Separates masking overhead from upstream/model latency — answers
    // "is the slowness us or the model" and catches masking regressions.
    `${req.method} ${path} -> ${upstream.status} ` +
      `(${Date.now() - started}ms total, masking ${maskMs}ms, upstream+stream ${Date.now() - started - maskMs}ms)`,
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
