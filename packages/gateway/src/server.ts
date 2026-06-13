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
import { SqlMaskHandle } from "./sql-mask.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";

/** Anthropic Messages endpoints (masked). */
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
/** OpenAI Chat Completions endpoint (masked). */
const CHAT_PATH = "/v1/chat/completions";
/** Other OpenAI-only paths — forwarded to OpenAI, not masked (unambiguous). */
const OPENAI_PASSTHROUGH_PATHS = new Set([
  "/v1/responses",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/moderations",
]);

export function createGateway(config: GatewayConfig): Server {
  const log = Logger.from(config);
  // One ephemeral store for the lifetime of this gateway process. Holds
  // real↔mock mappings in memory only; never persisted, never logged.
  const store = new SessionStore();

  const anthropicAdapter = new AnthropicAdapter(config.upstreamBaseUrl);
  const openaiAdapter = new OpenAIAdapter(config.openaiUpstreamBaseUrl);

  // Optional SQL-masking worker (off unless config.maskSql). Spawned once and
  // reused; reports readiness asynchronously and degrades gracefully.
  const sqlMask = new SqlMaskHandle(config, store, log);
  if (config.maskSql) {
    void sqlMask.ready().then((ok) =>
      log.info(
        ok
          ? "SQL masking enabled (sqlglot worker ready)"
          : "SQL masking requested but the sqlglot worker is unavailable — falling back to detector-only",
      ),
    );
  }

  const server = createServer((req, res) => {
    // Parse just the path; querystrings are forwarded as-is via req.url.
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0] ?? "/";

    // Local health check — never forwarded upstream.
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", upstream: config.upstreamBaseUrl }));
      return;
    }

    // Route by endpoint to the right wire-format adapter + upstream.
    //   /v1/messages*           → Anthropic adapter + api.anthropic.com (masked)
    //   /v1/chat/completions    → OpenAI adapter    + api.openai.com    (masked)
    //   other OpenAI-only paths → OpenAI upstream, forwarded (not masked)
    //   any other /v1/*         → Anthropic upstream, forwarded (current behavior)
    const isMessages = path === MESSAGES_PATH;
    const isCountTokens = path === COUNT_TOKENS_PATH;
    const isChat = path === CHAT_PATH;
    const isOpenAiOther = OPENAI_PASSTHROUGH_PATHS.has(path);

    let adapter = anthropicAdapter as ProxyContext["adapter"];
    let upstreamBaseUrl = config.upstreamBaseUrl;
    let inspect = isMessages || isCountTokens;
    if (isChat) {
      adapter = openaiAdapter;
      upstreamBaseUrl = config.openaiUpstreamBaseUrl;
      inspect = true;
    } else if (isOpenAiOther) {
      adapter = openaiAdapter;
      upstreamBaseUrl = config.openaiUpstreamBaseUrl;
      inspect = false;
    }

    const ctx: ProxyContext = {
      config,
      log,
      path: rawUrl,
      store,
      inspect,
      adapter,
      upstreamBaseUrl,
      sqlMask: config.maskSql ? sqlMask : null,
    };

    if (isMessages || isCountTokens || isChat || isOpenAiOther || path.startsWith("/v1/")) {
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

  // Tear down the worker subprocess when the server closes.
  server.on("close", () => sqlMask.close());
  return server;
}
