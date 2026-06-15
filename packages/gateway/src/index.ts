#!/usr/bin/env node
/**
 * @wyloc/gateway entry point.
 *
 * Loads config (from env for v1), starts the local proxy, and prints the
 * one line the operator needs: the ANTHROPIC_BASE_URL to point a fresh
 * `claude` session at.
 */

import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createGateway } from "./server.js";
import { WylocConfigError } from "./wyloc/index.js";
import { loadFromSource, startBackgroundRefresh } from "./wyloc/remote.js";
import { applyWyloc } from "./wyloc/apply.js";
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  let config = loadConfig();

  // Company config from a local path OR a remote URL. FAIL-CLOSED: any problem
  // stops startup with a specific report — a security gateway never runs on a
  // broken config (remote source uses last-known-good with a fail-closed floor).
  try {
    const { loaded: wyloc, origin } = await loadFromSource();
    if (wyloc) {
      config = applyWyloc(config, wyloc);
      const pc = wyloc.customPatterns.length;
      const via = origin === "url-cache" ? ` (LAST-KNOWN-GOOD cache — remote unreachable)` : origin === "url" ? ` (remote)` : "";
      console.error(
        `[wyloc] loaded ${wyloc.path}${via} — ${pc} custom pattern${pc === 1 ? "" : "s"}, ` +
          `${wyloc.internalScopes.length} internal scope(s), ${wyloc.blocklistSubstrings.length} blocklist term(s)`,
      );
      // Keep the cache fresh for URL sources (applies on next restart).
      startBackgroundRefresh(process.env, 5 * 60_000, (m) => console.error(m));
    }
  } catch (err) {
    if (err instanceof WylocConfigError) {
      console.error(err.format());
      process.exit(1);
    }
    throw err;
  }

  const log = Logger.from(config);
  const server = createGateway(config);

  server.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;
    log.info(`listening on ${base}`);
    log.info(`forwarding to upstream ${config.upstreamBaseUrl}`);
    log.info(
      `policy: onDetect=${config.onDetect}, injectSystemPrompt=${config.injectSystemPrompt}`,
    );
    log.info("");
    log.info("To route Claude Code through the gateway, start a FRESH session:");
    log.info(`  ANTHROPIC_BASE_URL=${base} claude`);
    log.info("(ANTHROPIC_BASE_URL is read once at startup — changing it mid-session does nothing.)");
  });

  server.on("error", (err) => {
    log.error("server error", err);
    process.exit(1);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`received ${sig}, shutting down.`);
      server.close(() => process.exit(0));
      // Destroy lingering connections (e.g. an open SSE stream) so close()
      // completes promptly and the port is released; the SQL worker child
      // then exits on stdin EOF. Fallback hard-exit guarantees teardown.
      server.closeAllConnections?.();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

// Dispatch: a CLI subcommand (setup/unsetup/service/status/help) is handled by
// runCli; no args or `start` falls through to running the gateway.
runCli(process.argv.slice(2))
  .then((handled) => {
    if (!handled) {
      return main().catch((err) => {
        console.error("[wyloc-gateway] fatal startup error:", err);
        process.exit(1);
      });
    }
    return undefined;
  })
  .catch((err) => {
    console.error("[wyloc] error:", err);
    process.exit(1);
  });
