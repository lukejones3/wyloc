import type { DetectorConfig } from "@wyloc/detector";

/**
 * Masking policy for @wyloc/code-masker. This is the seam that becomes the
 * enterprise `wyloc.json` central policy: every knob that decides *what* counts
 * as proprietary and *how* a mask is shaped lives here, so sensible defaults
 * ship now and orgs can override later without touching the engine.
 *
 * Defaults are CONSERVATIVE on the fuzzy categories (Bucket 2) and aggressive
 * on the unambiguous ones (internal declarations, comments, secrets).
 */
export interface CodeMaskerConfig {
  // ── Bucket 1: internal identifiers (AST + scope/import analysis) ──
  /** Mask internally-DEFINED classes. */
  maskClasses: boolean;
  /** Mask internally-DEFINED functions. */
  maskFunctions: boolean;
  /** Mask internally-DEFINED interfaces / type aliases. */
  maskTypes: boolean;
  /** Mask internally-DEFINED enums. */
  maskEnums: boolean;
  /** Mask internally-DEFINED namespaces / modules. */
  maskNamespaces: boolean;
  /**
   * Mask methods/properties of internal classes & interfaces (members).
   * Default OFF — see resolveConfig: member access on `any`-typed values can't
   * be resolved by the checker, so masking would be inconsistent. Enable on
   * well-typed codebases.
   */
  maskMembers: boolean;
  /** Mask names bound by a RELATIVE import (symbols defined elsewhere in the project). */
  maskRelativeImports: boolean;
  /** Mask the relative import PATH string itself (`"./billing/engine"` reveals architecture). */
  maskModuleSpecifiers: boolean;

  /**
   * Bare import specifiers (no leading `.`) treated as INTERNAL rather than
   * external — e.g. an org that publishes first-party packages under `@acme/*`.
   * Anything matching is masked like a relative import; everything else bare is
   * external and NEVER masked. Default empty = all bare specifiers are external.
   */
  internalScopes: readonly (string | RegExp)[];

  // ── Bucket 1: internal infrastructure in string literals ──
  /** Master toggle for internal URL/host/IP/path masking inside string literals. */
  maskStrings: boolean;
  /** Private IPv4 ranges (10/8, 172.16/12, 192.168/16). */
  maskPrivateIps: boolean;
  /** Internal TLDs — bare service names and hosts under these are masked. */
  internalTlds: readonly string[];
  /** Org-internal domains (e.g. "acme.com"); hosts under these are masked. */
  internalDomains: readonly string[];
  /** File-path patterns inside string literals to mask (architecture-revealing). */
  internalPathPatterns: readonly RegExp[];

  // ── Bucket 2: gated/fuzzier internal references in strings ──
  /** Master toggle for Bucket 2. Conservative: OFF unless patterns are supplied. */
  maskBucket2: boolean;
  /** Org regexes: any literal substring matching is masked (codenames, queue names…). */
  bucket2Patterns: readonly RegExp[];
  /** Org substrings: any literal CONTAINING one (case-insensitive) is masked. */
  bucket2Substrings: readonly string[];

  // ── Secrets (reuse @wyloc/detector — never rebuilt) ──
  /** Run the detector over the source and swap hardcoded secrets via buildSwap. */
  scrubSecrets: boolean;
  /** Config passed through to the detector's scan(). */
  detectorConfig: Partial<DetectorConfig>;

  // ── Comments ──
  /** Strip ALL comments. Deliberate, safe default — comments are a leak channel. */
  stripComments: boolean;

  // ── Mask shaping ──
  /** Length of the deterministic hash suffix embedded in masks. */
  hashLength: number;
  /** Per-session salt. "" = fully deterministic (tests). Pass random for unlinkability. */
  sessionSalt: string;

  // ── Members that must never be masked even on an internal class ──
  /** Standard prototype/lifecycle member names (overrides would break if renamed). */
  reservedMembers: readonly string[];
}

export type CodeMaskerConfigInput = Partial<CodeMaskerConfig>;

const DEFAULT_INTERNAL_TLDS = [
  "internal", "corp", "local", "intranet", "lan", "vpc", "k8s",
] as const;

/** Conservative default: home-directory absolute paths (leak usernames + layout). */
const DEFAULT_INTERNAL_PATH_PATTERNS = [
  /\/(?:Users|home)\/[^/\s"'`]+\/[^\s"'`]+/g,
  /[A-Za-z]:\\Users\\[^\\\s"'`]+\\[^\s"'`]+/g,
] as const;

const DEFAULT_RESERVED_MEMBERS = [
  "constructor", "toString", "valueOf", "toJSON", "then", "catch", "finally",
  "length", "name", "size", "next", "return", "throw",
  Symbol.iterator.toString(),
] as const;

export function resolveConfig(input: CodeMaskerConfigInput = {}): CodeMaskerConfig {
  return {
    maskClasses: input.maskClasses ?? true,
    maskFunctions: input.maskFunctions ?? true,
    maskTypes: input.maskTypes ?? true,
    maskEnums: input.maskEnums ?? true,
    maskNamespaces: input.maskNamespaces ?? true,
    // Default OFF: a masked member declaration whose access sites are `any`-typed
    // can't be resolved/renamed by the checker, which would leak the name at
    // those sites (partial masking). Opt in on well-typed code. See README.
    maskMembers: input.maskMembers ?? false,
    maskRelativeImports: input.maskRelativeImports ?? true,
    maskModuleSpecifiers: input.maskModuleSpecifiers ?? true,
    internalScopes: input.internalScopes ?? [],

    maskStrings: input.maskStrings ?? true,
    maskPrivateIps: input.maskPrivateIps ?? true,
    internalTlds: input.internalTlds ?? DEFAULT_INTERNAL_TLDS,
    internalDomains: input.internalDomains ?? [],
    internalPathPatterns: input.internalPathPatterns ?? DEFAULT_INTERNAL_PATH_PATTERNS,

    maskBucket2: input.maskBucket2 ?? false,
    bucket2Patterns: input.bucket2Patterns ?? [],
    bucket2Substrings: input.bucket2Substrings ?? [],

    scrubSecrets: input.scrubSecrets ?? true,
    detectorConfig: input.detectorConfig ?? {},

    stripComments: input.stripComments ?? true,

    hashLength: input.hashLength ?? 6,
    sessionSalt: input.sessionSalt ?? "",

    reservedMembers: input.reservedMembers ?? DEFAULT_RESERVED_MEMBERS,
  };
}
