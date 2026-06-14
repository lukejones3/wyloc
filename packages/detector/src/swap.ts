/**
 * Dummy-swap engine — structurally-valid mock replacement.
 *
 * The redaction path (`redact.ts`) replaces secrets with obvious
 * placeholders like `[REDACTED_AWS_ACCESS_KEY]`. That keeps the secret
 * safe but destroys the LLM's ability to reason about the code: a model
 * shown `[REDACTED_DATABASE_URL]` can't infer the connection shape, and
 * a model shown `[REDACTED_PRIVATE_KEY]` will emit syntax errors where a
 * real key block belonged.
 *
 * The swap engine solves this. Each secret is replaced with a
 * STRUCTURALLY VALID, completely fake value of the same shape:
 *
 *   real:  AKIA5XQ2WJ8NPLR3MKVT
 *   swap:  AKIAMOCK7H3N2QF8XK4P      (valid AWS key shape, not a real key)
 *
 *   real:  postgres://admin:s3cr3t@prod-db.acme.io:5432/billing
 *   swap:  postgres://user:mock_pw@mock-host.example:5432/mock_db
 *
 * The LLM keeps 100% of its structural/semantic reasoning. When its
 * response comes back referencing the mock, the consuming surface
 * (browser extension / IDE) rehydrates the real value from the mapping.
 *
 * DETERMINISM: the same secret + same session salt always produces the
 * same mock, so a value referenced N times in one prompt maps to one
 * consistent mock and the model can track the relationship. We achieve
 * this WITHOUT storing the secret — the mock is derived by hashing.
 *
 * This module is pure (no DOM, no Node, no crypto dependency). The
 * ephemeral mapping store and the rehydration listeners live in the
 * consuming surface, not here.
 */

import type { Finding, SecretType } from "./types.js";

/** One real→mock substitution produced by a swap. */
export interface SwapMapping {
  /** The original secret value. LOCAL ONLY — never persist or transmit. */
  real: string;
  /** The structurally-valid fake that replaces it. */
  mock: string;
  /** Secret type, for diagnostics. */
  type: SecretType;
}

/** Result of swapping a block of text. */
export interface SwapResult {
  /** Text with every finding replaced by its structural mock. */
  swappedText: string;
  /** Real→mock mappings, deduplicated by real value. */
  mappings: SwapMapping[];
}

// ── Deterministic hashing (FNV-1a, 32-bit) ─────────────────────────
//
// We need a fast, dependency-free, deterministic hash to derive stable
// mock suffixes. FNV-1a is ideal: tiny, well-distributed for short
// strings, and not reversible to the original in any practical inline
// sense (we are not claiming cryptographic secrecy — the real value
// never leaves the machine regardless; this only needs to be stable
// and collision-resistant enough across a single prompt).

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Base36 token of `len` chars derived deterministically from input. */
function token(input: string, len: number): string {
  // Chain two hashes so we have enough entropy for longer tokens.
  let out = "";
  let h = fnv1a(input);
  while (out.length < len) {
    out += h.toString(36).padStart(7, "0");
    h = fnv1a(out + input);
  }
  return out.slice(0, len);
}

/**
 * Structural mock generators.
 *
 * Two philosophies, applied per type:
 *
 *  1. STRUCTURAL types (database URLs, service-account emails): the model
 *     needs the SHAPE to write correct surrounding code, so we mock with
 *     a structurally-valid stand-in (same scheme/port/format).
 *
 *  2. OPAQUE-SECRET types (API keys, tokens, private keys): the model
 *     does NOT need the real shape — it just needs a placeholder token to
 *     drop into the code. Critically, a *realistic-looking* key mock makes
 *     safety-tuned models REFUSE the prompt ("that looks like a real
 *     credential"), defeating the purpose. So for these we emit an
 *     OBVIOUS, non-sensitive placeholder like `WYLOC_MOCK_AWS_KEY_a8f9b2`.
 *     The model recognizes it as a harmless stand-in, writes the code, and
 *     copy-out rehydration restores the real value.
 */

/** Uppercase identifier-safe slug for a mock label (e.g. "Employee ID" → EMPLOYEE_ID). */
function slug(label: string): string {
  const s = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "CUSTOM";
}

/** Obvious, non-sensitive placeholder for an opaque secret. `label` is a
 *  SecretType or a non-sensitive custom hint; both are slugged identically. */
function placeholder(label: string, seed: string): string {
  const tag = token(seed, 6).toUpperCase();
  return `WYLOC_MOCK_${slug(label)}_${tag}`;
}

function mockFor(real: string, type: SecretType, salt: string, hint?: string): string {
  const seed = real + "::" + salt;

  // Org-defined custom patterns: shape the mock from the pattern's
  // non-sensitive label so the model (and humans) can tell what it stands for.
  if (type === "custom") return placeholder(hint ?? "custom", seed);

  switch (type) {
    // ── Structural types: shape carries meaning, keep it realistic ──
    case "database_url":
      return mockDatabaseUrl(real, seed);

    case "gcp_service_account":
      // Service-account emails appear in code as identifiers the model
      // may reference; keep the email shape but make it obviously mock.
      return `wyloc-mock-${token(seed, 6)}@mock-project.iam.gserviceaccount.com`;

    // ── Opaque secrets: obvious placeholder, never a realistic key ──
    case "aws_access_key":
    case "aws_secret_key":
    case "gcp_api_key":
    case "azure_token":
    case "github_token":
    case "gitlab_token":
    case "slack_token":
    case "stripe_key":
    case "openai_key":
    case "anthropic_key":
    case "jwt":
    case "oauth_bearer":
    case "private_key":
    case "generic_api_key":
    case "env_assignment":
    case "high_entropy_string":
    default:
      return placeholder(type, seed);
  }
}

/**
 * Rebuild a database URL with mock credentials/host but the SAME scheme,
 * port, and overall structure, so the model reasons about it correctly.
 * Falls back to a generic mock if the URL doesn't parse.
 */
function mockDatabaseUrl(real: string, seed: string): string {
  // Match: scheme://[user[:pass]@]host[:port][/db][...]
  const m = real.match(
    /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^:@/]+)(?::([^@/]+))?@)?([^:/?#]+)(?::(\d+))?(\/[^?#]*)?/,
  );
  if (!m) {
    return "postgres://user:mock_pw@mock-host.example:5432/mock_db";
  }
  const scheme = m[1];
  const hasUser = m[2] !== undefined;
  const hasPass = m[3] !== undefined;
  const port = m[5];
  const path = m[6];

  let auth = "";
  if (hasUser) {
    auth = "user";
    if (hasPass) auth += ":mock_" + token(seed, 6);
    auth += "@";
  }
  const host = "mock-host.example";
  const portPart = port ? ":" + port : "";
  const pathPart = path ? "/mock_db" : "";

  return `${scheme}://${auth}${host}${portPart}${pathPart}`;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Replace every finding in `text` with a deterministic structural mock.
 *
 * @param text     the original prompt text
 * @param findings detector findings (with start/end/value/type)
 * @param salt     a per-session random salt; the SAME salt must be used
 *                 for rehydration within a session so mappings line up
 * @returns swappedText and the real→mock mappings (deduped by real value)
 *
 * Determinism: identical (real value, salt) pairs always yield the same
 * mock, so repeated secrets collapse to one mapping and the model sees a
 * consistent token throughout the prompt.
 */
export function buildSwap(
  text: string,
  findings: Finding[],
  salt: string,
): SwapResult {
  if (findings.length === 0) {
    return { swappedText: text, mappings: [] };
  }

  // Deduplicate by real value so the same secret maps to one mock.
  const byReal = new Map<string, SwapMapping>();
  for (const f of findings) {
    if (byReal.has(f.value)) continue;
    byReal.set(f.value, {
      real: f.value,
      mock: mockFor(f.value, f.type, salt, f.maskHint),
      type: f.type,
    });
  }

  // Apply substitutions back-to-front so earlier offsets stay valid.
  // We use the findings' own spans (not a global search/replace) to
  // avoid accidentally rewriting unrelated occurrences of a substring.
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let swapped = text;
  for (const f of ordered) {
    const mapping = byReal.get(f.value);
    if (!mapping) continue;
    swapped = swapped.slice(0, f.start) + mapping.mock + swapped.slice(f.end);
  }

  return { swappedText: swapped, mappings: [...byReal.values()] };
}

/**
 * Reverse a swap: given text that may contain mocks (e.g. an LLM reply),
 * replace every mock with its real value. Used by the consuming surface
 * on copy-out / accept, so the developer gets working code back.
 *
 * Mocks are replaced longest-first to avoid partial-overlap issues.
 */
export function rehydrate(text: string, mappings: SwapMapping[]): string {
  if (mappings.length === 0) return text;
  const ordered = [...mappings].sort((a, b) => b.mock.length - a.mock.length);
  let result = text;
  for (const m of ordered) {
    if (!m.mock) continue;
    // Replace all occurrences of the mock with the real value.
    result = result.split(m.mock).join(m.real);
  }
  return result;
}
