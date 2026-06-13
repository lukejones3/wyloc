/**
 * Gateway configuration — the single seam that controls all behavior.
 *
 * This is deliberately a plain config object loaded once at process
 * start. For v1 it is sourced from environment variables (local use),
 * but the SHAPE is what matters: this is the exact surface that later
 * becomes an enterprise central-policy document pushed from a control
 * plane. Nothing about gateway behavior is hardcoded elsewhere — every
 * decision (where to forward, which detector patterns are live, whether
 * to swap or block, whether to inject the system directive, which port)
 * is read from here.
 *
 * Detector tuning is expressed as a `Partial<DetectorConfig>` and handed
 * straight to `scan()` — the gateway does not reimplement detection, it
 * only configures the shared engine.
 */

import type { DetectorConfig } from "@wyloc/detector";

/** What to do when the request path detects a secret. */
export type DetectAction = "swap" | "block";

export interface GatewayConfig {
  /** TCP port the local proxy listens on. */
  port: number;
  /** Address to bind. Loopback by default — never expose this off-box. */
  host: string;
  /**
   * Upstream Anthropic API origin (for /v1/messages*). Requests are forwarded
   * to `${upstreamBaseUrl}${path}` with the caller's own credentials. The
   * gateway relays auth, it never substitutes it.
   */
  upstreamBaseUrl: string;
  /** Upstream OpenAI API origin (for /v1/chat/completions and other OpenAI paths). */
  openaiUpstreamBaseUrl: string;
  /**
   * Detector tuning passed verbatim to `scan()`. Controls which patterns
   * are active (via `suppressedRuleIds`), entropy thresholds, allowlist,
   * etc. Empty object = detector defaults (all patterns on).
   */
  detector: Partial<DetectorConfig>;
  /**
   * Behavior when a secret is found in outbound user text:
   *  - "swap"  → replace with a WYLOC_MOCK_ placeholder and continue
   *  - "block" → reject the request with an error, never forward
   */
  onDetect: DetectAction;
  /**
   * Inject a directive into the system prompt telling the model to echo
   * any WYLOC_MOCK_ tokens verbatim so they round-trip for rehydration.
   * Toggle-able; defaults on.
   */
  injectSystemPrompt: boolean;
  /**
   * Verbose request/response logging. NOTE: logging is metadata-only by
   * contract — secret values and mock↔real mappings are NEVER logged at
   * any verbosity. This only toggles the non-sensitive operational lines.
   */
  verbose: boolean;
  /**
   * Mask proprietary SQL identifiers + scrub sensitive literals in outbound
   * SQL via @wyloc/sql-masker, in addition to detector secret-swapping.
   * Default OFF. Requires a Python3 + sqlglot worker; if it can't start, the
   * gateway logs once and falls back to detector-only behavior.
   */
  maskSql: boolean;
  /** SQL dialect handed to the masker's parser. */
  sqlDialect: string;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Build the runtime config from environment variables. This is the only
 * place env is read; everything downstream takes a `GatewayConfig`.
 */
export function loadConfig(): GatewayConfig {
  const onDetectRaw = envStr("WYLOC_ON_DETECT", "swap").toLowerCase();
  const onDetect: DetectAction = onDetectRaw === "block" ? "block" : "swap";

  // Trim a trailing slash so `${base}${path}` never doubles up.
  const upstreamBaseUrl = envStr(
    "WYLOC_UPSTREAM_BASE_URL",
    "https://api.anthropic.com",
  ).replace(/\/+$/, "");
  const openaiUpstreamBaseUrl = envStr(
    "WYLOC_OPENAI_UPSTREAM_BASE_URL",
    "https://api.openai.com",
  ).replace(/\/+$/, "");

  return {
    port: envInt("WYLOC_GATEWAY_PORT", 8787),
    host: envStr("WYLOC_GATEWAY_HOST", "127.0.0.1"),
    upstreamBaseUrl,
    openaiUpstreamBaseUrl,
    detector: {},
    onDetect,
    injectSystemPrompt: envBool("WYLOC_INJECT_SYSTEM_PROMPT", true),
    verbose: envBool("WYLOC_VERBOSE", true),
    maskSql: envBool("WYLOC_MASK_SQL", false),
    sqlDialect: envStr("WYLOC_SQL_DIALECT", "postgres"),
  };
}
