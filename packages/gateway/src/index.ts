#!/usr/bin/env node
/**
 * @wyloc/gateway entry point.
 *
 * Loads config (from env for v1), starts the local proxy, and prints the
 * one line the operator needs: the ANTHROPIC_BASE_URL to point a fresh
 * `claude` session at.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { loadConfig, type GatewayConfig } from "./config.js";
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

  // COBOL's 9.5MB grammar module fatally OOMs V8's OPTIMIZING wasm compiler
  // on newer Nodes (≥23, turboshaft) — a background thread kills the process
  // after parses already succeeded. Baseline-only compilation (--liftoff-only)
  // is proven safe, but V8 flags only take effect at process start, so when
  // COBOL is enabled under plain `node` we re-exec ourselves ONCE with the
  // flag. The packaged SEA binary skips this: it pins Node 22 (unaffected),
  // and an SEA binary cannot consume node/V8 flags anyway.
  if (maybeReexecForCobol(config)) return;

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

/**
 * Re-exec `node --liftoff-only <same script + args>` when COBOL masking is on
 * and the flag isn't set yet. Returns true when a child was spawned (the
 * caller must NOT continue starting the gateway). No-ops inside the SEA
 * binary (Node 22 pin is safe; SEA can't take node flags) and when already
 * flagged (the child's own pass through this function).
 */
function maybeReexecForCobol(config: GatewayConfig): boolean {
  if (!config.maskLanguages.includes("cobol")) return false;
  if (process.execArgv.includes("--liftoff-only")) return false;
  try {
    // node:sea exists on Node ≥21.7; on older Nodes assume non-SEA.
    // (createRequire works in both the ESM source and the CJS SEA bundle,
    // whose import.meta.url is shimmed to the binary path.)
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    if (sea.isSea?.()) return false;
  } catch {
    /* pre-SEA node — plain-node path below is correct */
  }
  console.error("[wyloc] COBOL masking enabled — re-executing with --liftoff-only (V8 wasm baseline tier)");
  const child = spawn(
    process.execPath,
    ["--liftoff-only", ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  return true;
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
