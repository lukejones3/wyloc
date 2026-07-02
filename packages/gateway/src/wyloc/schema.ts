/**
 * wyloc.json — the company configuration contract.
 *
 * This is a CUSTOMER-FACING contract: clarity and safety over cleverness. A
 * company declares its org-specific masking rules once here; the loader
 * (load.ts) validates the whole file FAIL-CLOSED and compiles it into the
 * shared masking surfaces (detector / sql-masker / code-masker / gateway).
 *
 * The shapes below are the documented schema. They are intentionally a plain
 * data contract (no behavior) so they can be published as-is.
 */

/** Character-class building block for prefix/context value shapes. */
export type FormatKind =
  | "digits" // \d
  | "alpha" // A–Z a–z
  | "alnum" // A–Z a–z 0–9
  | "hex" // 0–9 a–f A–F
  | "upper" // A–Z
  | "lower" // a–z
  | "upperalnum"; // A–Z 0–9

/** A length-bounded run of one character class. Exactly one of length | {min,max}. */
export type Format =
  | { kind: FormatKind; length: number }
  | { kind: FormatKind; min: number; max: number };

/** Pre-vetted common shapes the customer can pick by name (no regex needed). */
export type KnownFormat = "ipv4" | "email" | "uuid" | "mac" | "us_phone" | "iban";

/**
 * The match definition for a custom pattern. Discriminated on `type`.
 * The first four are CONSTRAINED / safe-by-construction; `regex` is the opt-in
 * advanced escape hatch (strictest validation, RE2-only at runtime).
 */
export type Match =
  | { type: "prefix"; prefix: string; format: Format; caseInsensitive?: boolean }
  | { type: "context"; keywords: string[]; value: Format; window?: number }
  | { type: "list"; terms: string[]; wholeWord?: boolean; caseInsensitive?: boolean }
  | { type: "known"; format: KnownFormat }
  | { type: "regex"; advanced: true; source: string; flags?: string };

/** One custom sensitive-value rule. */
export interface CustomPattern {
  /** Non-sensitive label. Shapes the mock (e.g. "Employee ID" → WYLOC_MOCK_EMPLOYEE_ID_…). */
  name: string;
  /** Optional stable id (telemetry/suppression). Defaults to a slug of `name`. */
  id?: string;
  /** Action on match. "swap" (default) masks + rehydrates; "block" rejects the request. */
  action?: "swap" | "block";
  /** What to match. */
  match: Match;
  /** Self-test fixtures. REQUIRED for type:"regex"; recommended otherwise. */
  examples?: { match: string[]; noMatch?: string[] };
}

/** Per-category logging granularity (metadata-only is enforced regardless). */
export type LogGranularity = "aggregate" | "per_incident";

/** The whole wyloc.json document. */
export interface WylocConfig {
  /** Schema version. Only `1` is supported today. */
  version: 1;
  patterns?: CustomPattern[];
  /** Bare import scopes the code-masker treats as internal (e.g. "@acme/*"). */
  internalScopes?: string[];
  /** Org domains whose hosts are masked in strings/URLs (e.g. "acme.com"). */
  internalDomains?: string[];
  /** Specific internal hostnames to mask (e.g. "jenkins.acme.io"). */
  internalHosts?: string[];
  /** Internal TLD labels (extends the built-in internal/corp/local set). */
  internalTlds?: string[];
  /** Literal proprietary terms masked everywhere. */
  blocklist?: string[];
  /**
   * Languages the poly-masker masks (Go/Java/C#/Kotlin/Python). A company
   * lists only the languages it uses; each grammar loads lazily. TS/JS are
   * governed by policy.code, not this list.
   */
  languages?: string[];
  /**
   * Per-language internal package/module prefixes — the classification signal
   * for internal-vs-external, the analog of internalScopes:
   *   { "go": ["github.com/acme/billing"], "java": ["com.acme."],
   *     "csharp": ["Acme."], "kotlin": ["com.acme."], "python": ["acme_billing"] }
   * Manifest auto-discovery (go.mod, …) merges in additional prefixes.
   */
  internalPackagePrefixes?: Partial<Record<"go" | "java" | "csharp" | "kotlin" | "python" | "cobol", string[]>>;
  /** Which masking categories are on/off. */
  policy?: {
    sql?: boolean;
    code?: boolean;
    fileReads?: boolean;
    members?: boolean;
    pii?: { creditCard?: boolean; ssn?: boolean };
  };
  /** Logging granularity preferences. */
  logging?: {
    default?: LogGranularity;
    categories?: Partial<Record<"secrets" | "pii" | "custom" | "code" | "sql", LogGranularity>>;
  };
}

/** Known top-level keys, for unknown-key (typo) rejection. */
export const WYLOC_TOP_LEVEL_KEYS = [
  "version", "patterns", "internalScopes", "internalDomains", "internalHosts",
  "internalTlds", "blocklist", "languages", "internalPackagePrefixes", "policy", "logging",
] as const;

/** Languages accepted in `languages` / `internalPackagePrefixes`. */
export const POLY_LANGUAGES = ["go", "java", "csharp", "kotlin", "python", "cobol"] as const;

/** Known keys on a pattern object, for unknown-key rejection. */
export const PATTERN_KEYS = ["name", "id", "action", "match", "examples"] as const;
