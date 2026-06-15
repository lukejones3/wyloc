/**
 * Config SOURCE resolution: a local path OR a remote URL, so a company can
 * centralize policy (every machine points at one URL and gets the same enforced
 * rules).
 *
 * REMOTE POLICY — "last-known-good with a fail-closed floor" (the recommended
 * tradeoff: never run a security tool with NO policy, but don't break a dev on
 * a transient config-server blip):
 *
 *   reachable + valid     → use it; cache as last-known-good.
 *   reachable + INVALID   → FAIL-CLOSED (refuse to start). Never silently fall
 *                           back to an older cache when the server is actively
 *                           serving a broken policy — surface it.
 *   unreachable + cache   → run the cached validated policy (loud log). The dev
 *                           keeps working; policy is still enforced.
 *   unreachable + NO cache→ FAIL-CLOSED (true first run with no policy at all).
 *
 * Validation is the SAME fail-closed path as a local file (loadWylocConfig);
 * we fetch to a temp file and run it through the existing loader, so a remote
 * config can never reach the surfaces without passing every check.
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadWylocConfig, WylocConfigError, wylocConfigPath, type LoadedWylocConfig } from "./load.js";

export interface ConfigSource {
  kind: "file" | "url";
  /** File path or URL. */
  location: string;
}

/** Where the config comes from: WYLOC_CONFIG_URL wins, else the local path. */
export function configSource(env: NodeJS.ProcessEnv = process.env): ConfigSource {
  if (env.WYLOC_CONFIG_URL && env.WYLOC_CONFIG_URL.length > 0) {
    return { kind: "url", location: env.WYLOC_CONFIG_URL };
  }
  return { kind: "file", location: wylocConfigPath(env) };
}

function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WYLOC_CACHE_DIR && env.WYLOC_CACHE_DIR.length > 0
    ? env.WYLOC_CACHE_DIR
    : join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "wyloc");
}
function lastKnownGoodPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), "last-known-good.json");
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export interface RemoteLoadResult {
  loaded: LoadedWylocConfig | null;
  /** How the config was obtained, for logging. */
  origin: "none" | "file" | "url" | "url-cache";
}

/**
 * Resolve + validate the config from its source. Throws `WylocConfigError`
 * (fail-closed) when there is no usable, valid policy. Returns `{loaded:null}`
 * only when a LOCAL file is simply absent (the pre-existing env-only behavior).
 */
export async function loadFromSource(
  env: NodeJS.ProcessEnv = process.env,
  opts: { timeoutMs?: number } = {},
): Promise<RemoteLoadResult> {
  const src = configSource(env);

  if (src.kind === "file") {
    const loaded = loadWylocConfig(src.location);
    return { loaded, origin: loaded ? "file" : "none" };
  }

  // URL source.
  const cache = lastKnownGoodPath(env);
  let text: string;
  try {
    text = await fetchText(src.location, opts.timeoutMs ?? 5000);
  } catch (err) {
    // Unreachable. Fall back to last-known-good if we have one; else fail-closed.
    if (existsSync(cache)) {
      const loaded = loadWylocConfig(cache); // re-validate the cached copy
      return { loaded, origin: "url-cache" };
    }
    throw new WylocConfigError(src.location, [
      `remote config unreachable (${(err as Error).message}) and no cached last-known-good exists. ` +
        `Refusing to start without a policy. Make the config URL reachable, or use a local wyloc.json.`,
    ]);
  }

  // Reachable: validate via the SAME fail-closed loader (through a temp file).
  mkdirSync(cacheDir(env), { recursive: true });
  const staged = join(cacheDir(env), "staged.json");
  writeFileSync(staged, text);
  // Throws WylocConfigError if invalid — we do NOT update the cache in that case.
  const loaded = loadWylocConfig(staged);
  if (loaded) copyFileSync(staged, cache); // promote to last-known-good
  return { loaded, origin: "url" };
}

/**
 * Start a background refresh that keeps the last-known-good cache current for a
 * URL source. On success it updates the cache (applied on next start); on
 * failure it keeps the existing cache and logs. Returns a stop function.
 * (In-process hot-swap of live policy is a v2 enhancement.)
 */
export function startBackgroundRefresh(
  env: NodeJS.ProcessEnv,
  intervalMs: number,
  log: (msg: string) => void,
): () => void {
  const src = configSource(env);
  if (src.kind !== "url") return () => {};
  const timer = setInterval(async () => {
    try {
      const text = await fetchText(src.location, 5000);
      mkdirSync(cacheDir(env), { recursive: true });
      const staged = join(cacheDir(env), "staged.json");
      writeFileSync(staged, text);
      const loaded = loadWylocConfig(staged); // validate before promoting
      if (loaded) {
        copyFileSync(staged, lastKnownGoodPath(env));
        log(`[wyloc] refreshed policy from ${src.location} (applies on next restart)`);
      }
    } catch (e) {
      log(`[wyloc] policy refresh failed (${(e as Error).message}); keeping last-known-good`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
