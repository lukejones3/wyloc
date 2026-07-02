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
import { DEFAULT_LANGUAGES, IMPLEMENTED_LANGUAGES } from "@wyloc/poly-masker";

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
  /** Upstream Google Gemini API origin (for /v1beta/models/*:generateContent). */
  geminiUpstreamBaseUrl: string;
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
  /**
   * Mask proprietary TS/JS identifiers (internal classes/functions/types),
   * internal URLs/hosts/paths, and strip comments in fenced code blocks via
   * @wyloc/code-masker, in addition to detector secret-swapping. Default OFF.
   * Pure in-process (no worker) — nothing to fail to start.
   */
  maskCode: boolean;
  /**
   * Also mask methods/properties of internal classes (members). Default OFF —
   * member access on `any`-typed values can't be resolved, so masking would be
   * inconsistent. Enable for well-typed codebases. See @wyloc/code-masker.
   */
  maskCodeMembers: boolean;
  /**
   * Mask the TEXT content of tool results / tool messages — the files Claude
   * Code and Codex read on their own and send to the model. The detector runs
   * unconditionally on this content (the core win: secrets/PII in any file,
   * incl. .env/config/logs that aren't SQL or code); the SQL and code maskers
   * additionally apply when their own toggle is on and the content sniffs as
   * SQL / TS-JS. Tool-call STRUCTURE (ids, names, arguments) is never touched.
   * Default ON — set false to restore the prior pass-through behavior.
   */
  maskFileReads: boolean;
  /**
   * Mask the VALUES of every assignment in content confidently sniffed as an
   * env file (KEY=value), keeping keys + structure visible. Catches sensitive
   * env values that match no known secret pattern. Applies to typed/pasted
   * content and to files an agent reads (the file-read content-router). Default
   * ON — an .env is the most dangerous file an agent can read; over-masking a
   * non-env block is safe (swap+rehydrate), missing a real .env is not.
   */
  maskEnv: boolean;
  /**
   * Languages masked by @wyloc/poly-masker (Go/Java/C#/Kotlin/Python/Rust/C/
   * C++/COBOL), each loading its tree-sitter grammar lazily. DEFAULT: the
   * common-language set (all implemented except COBOL) — a deployment that
   * configures nothing still protects them. Narrow via wyloc.json `languages`
   * or WYLOC_MASK_LANGUAGES; keywords "defaults", "all", "none"/"off". Empty =
   * poly masking off. TS/JS are separate (maskCode) and stay on the TypeScript
   * Compiler API.
   */
  maskLanguages: string[];
  /**
   * Root used for project-manifest auto-discovery (go.mod, pom.xml, .csproj,
   * pyproject.toml → internal package prefixes) — and, later, the project
   * symbol index. Defaults to the gateway's cwd (where wyloc.json lives).
   */
  projectRoot: string;

  // ── Derived from wyloc.json (empty unless a config file sets them) ──
  /** Bare import scopes the code-masker treats as internal (e.g. "@acme/*"). */
  internalScopes: string[];
  /** Org domains + specific hosts masked in code strings/URLs. */
  internalDomains: string[];
  /** Internal TLD labels extending the code-masker defaults. */
  internalTlds: string[];
  /** Blocklist terms fed to the sql/code masker literal passes. */
  blocklistSubstrings: string[];
  /**
   * Per-language internal package/module prefixes for the poly-masker — the
   * analog of internalScopes (go module paths, java/kotlin package prefixes,
   * C# namespace prefixes, python top-level packages). From wyloc.json;
   * manifest auto-discovery merges in at the handle.
   */
  internalPackagePrefixes: Partial<Record<string, string[]>>;
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
 * Expand a raw `languages` token list (from WYLOC_MASK_LANGUAGES or wyloc.json)
 * into concrete language ids. Keywords:
 *   • "defaults" / "default" → the common-language default set (no COBOL)
 *   • "all"                  → every implemented language (incl. COBOL)
 *   • "none" / "off"         → disable poly masking entirely (escape hatch)
 * Bare language ids pass through in listed order; keywords expand in canonical
 * order; the result is de-duplicated. Unknown tokens are kept as-is here — the
 * poly-mask handle filters to IMPLEMENTED_LANGUAGES, and wyloc.json validation
 * rejects unknown ids upstream (with did-you-mean hints). A `none`/`off` token
 * anywhere in the list wins and yields the empty set.
 */
/** Split a comma/space-separated env value into trimmed, non-empty tokens. */
function splitList(value: string): string[] {
  return value.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function resolveMaskLanguages(tokens: readonly string[]): string[] {
  const out: string[] = [];
  const add = (l: string): void => {
    if (!out.includes(l)) out.push(l);
  };
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    if (t === "") continue;
    if (t === "none" || t === "off") return [];
    if (t === "all") IMPLEMENTED_LANGUAGES.forEach(add);
    else if (t === "default" || t === "defaults") DEFAULT_LANGUAGES.forEach(add);
    else add(t);
  }
  return out;
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
  const geminiUpstreamBaseUrl = envStr(
    "WYLOC_GEMINI_UPSTREAM_BASE_URL",
    "https://generativelanguage.googleapis.com",
  ).replace(/\/+$/, "");

  return {
    port: envInt("WYLOC_GATEWAY_PORT", 8787),
    host: envStr("WYLOC_GATEWAY_HOST", "127.0.0.1"),
    upstreamBaseUrl,
    openaiUpstreamBaseUrl,
    geminiUpstreamBaseUrl,
    detector: {},
    onDetect,
    injectSystemPrompt: envBool("WYLOC_INJECT_SYSTEM_PROMPT", true),
    verbose: envBool("WYLOC_VERBOSE", true),
    // Default ON: baseline coverage without configuration. SQL needs the
    // sqlglot worker (bundled in the binary; from source it degrades to
    // detector-only if python3+sqlglot is absent). TS/JS is pure in-process.
    maskSql: envBool("WYLOC_MASK_SQL", true),
    sqlDialect: envStr("WYLOC_SQL_DIALECT", "postgres"),
    maskCode: envBool("WYLOC_MASK_CODE", true),
    maskCodeMembers: envBool("WYLOC_MASK_CODE_MEMBERS", false),
    maskFileReads: envBool("WYLOC_MASK_FILE_READS", true),
    maskEnv: envBool("WYLOC_MASK_ENV", true),
    // Default: the common-language set (COBOL opt-in). WYLOC_MASK_LANGUAGES
    // unset/empty → defaults; a value narrows/expands it (keywords accepted).
    maskLanguages: resolveMaskLanguages(
      splitList(envStr("WYLOC_MASK_LANGUAGES", "defaults")),
    ),
    projectRoot: envStr("WYLOC_PROJECT_ROOT", process.cwd()),
    internalScopes: [],
    internalDomains: [],
    internalTlds: [],
    blocklistSubstrings: [],
    internalPackagePrefixes: {},
  };
}
