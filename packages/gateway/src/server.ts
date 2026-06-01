/**
 * HTTP server + routing.
 *
 * A deliberately tiny `node:http` server — no framework. It recognizes
 * the Anthropic Messages endpoints and forwards everything to the
 * upstream proxy. A local `/healthz` is handled in-process so the
 * operator can confirm the gateway is listening without an API key.
 */

import { createServer, type Server } from "node:http";
import type { GatewayConfig } from "./config.js";
import { Logger } from "./logger.js";
import { forward, sendGatewayError, type ProxyContext } from "./proxy.js";
import { SessionStore } from "./session.js";

/** Endpoints we explicitly expose in Anthropic Messages format. */
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

export function createGateway(config: GatewayConfig): Server {
  const log = Logger.from(config);
  // One ephemeral store for the lifetime of this gateway process. Holds
  // real↔mock mappings in memory only; never persisted, never logged.
  const store = new SessionStore();

  return createServer((req, res) => {
    // Parse just the path; querystrings are forwarded as-is via req.url.
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0] ?? "/";

    // Local health check — never forwarded upstream.
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", upstream: config.upstreamBaseUrl }));
      return;
    }

    // The two Messages endpoints carry user text we inspect/rewrite.
    // Everything else (model list, etc.) is still forwarded so the gateway
    // is a drop-in base URL, but is never scanned or rewritten.
    const isMessages = path === MESSAGES_PATH;
    const isCountTokens = path === COUNT_TOKENS_PATH;
    const ctx: ProxyContext = {
      config,
      log,
      path: rawUrl,
      store,
      inspect: isMessages || isCountTokens,
    };

    if (isMessages || isCountTokens || path.startsWith("/v1/")) {
      void forward(req, res, ctx).catch((err) => {
        log.error(`unhandled error for ${path}`, err);
        if (!res.headersSent) {
          sendGatewayError(res, 500, "Internal gateway error.");
        } else {
          res.end();
        }
      });
      return;
    }

    sendGatewayError(res, 404, `No route for ${path}.`);
  });
}
