import {
  resolveConfig as resolveCodeMaskerConfig,
  type CodeMaskerConfig,
} from "@wyloc/code-masker";
import type { DetectorConfig } from "@wyloc/detector";
import type { LanguageId } from "./types.js";

/**
 * Masking policy for @wyloc/poly-masker. Mirrors @wyloc/code-masker's config
 * philosophy: aggressive on the unambiguous categories (internal declarations,
 * comments, secrets), conservative on the fuzzy ones (Bucket 2 off by default,
 * member masking off for every language — Python permanently, the rest
 * until/unless a semantic tool is added).
 *
 * The string-literal pass (internal hosts / private IPs / paths / Bucket 2) is
 * REUSED from @wyloc/code-masker verbatim, so the same wyloc.json inputs
 * produce the same in-string masks in every language. `strings` below is the
 * resolved code-masker config that pass runs against.
 */
export interface PolyMaskerConfig {
  /** Languages this instance will mask. Grammar WASM loads lazily per language. */
  languages: readonly LanguageId[];
  /**
   * Per-language internal package/module prefixes — the analog of the TS
   * masker's `internalScopes`, and the make-or-break classification signal:
   * an import matching a prefix is INTERNAL (masked); anything else is
   * external and never touched.
   *   go:     module paths ("github.com/acme/billing")
   *   java:   package prefixes ("com.acme.")
   *   csharp: namespace prefixes ("Acme.")
   *   kotlin: package prefixes ("com.acme.")
   *   python: top-level package names ("acme_billing")
   */
  internalPackagePrefixes: Readonly<Partial<Record<LanguageId, readonly string[]>>>;
  /** Mask internal import/package PATHS themselves (they reveal architecture). */
  maskModuleSpecifiers: boolean;
  /**
   * Mask members (methods/properties) of internal types. Reserved: OFF for all
   * five languages — syntactic parsing cannot meet the type-completeness gate
   * (mask a member only if EVERY access site resolves). Present so the policy
   * seam exists; the engine currently ignores it by design.
   */
  maskMembers: boolean;
  /** Strip ALL comments (same deliberate default as the TS/SQL maskers). */
  stripComments: boolean;
  /** Run @wyloc/detector over the masked output and swap hardcoded secrets. */
  scrubSecrets: boolean;
  /** Config passed through to the detector's scan(). */
  detectorConfig: Partial<DetectorConfig>;
  /** Per-session salt. "" = fully deterministic (tests). */
  sessionSalt: string;
  /** Length of the deterministic hash suffix embedded in masks. */
  hashLength: number;
  /** Resolved policy for the reused code-masker string-literal pass. */
  strings: CodeMaskerConfig;
}

export interface PolyMaskerConfigInput {
  languages?: LanguageId[];
  internalPackagePrefixes?: Partial<Record<LanguageId, string[]>>;
  maskModuleSpecifiers?: boolean;
  maskMembers?: boolean;
  stripComments?: boolean;
  scrubSecrets?: boolean;
  detectorConfig?: Partial<DetectorConfig>;
  sessionSalt?: string;
  hashLength?: number;
  // ── string-literal pass (forwarded to the code-masker resolver) ──
  maskStrings?: boolean;
  maskPrivateIps?: boolean;
  internalTlds?: string[];
  internalDomains?: string[];
  maskBucket2?: boolean;
  bucket2Patterns?: RegExp[];
  bucket2Substrings?: string[];
}

export function resolveConfig(input: PolyMaskerConfigInput = {}): PolyMaskerConfig {
  const sessionSalt = input.sessionSalt ?? "";
  const hashLength = input.hashLength ?? 6;
  return {
    languages: input.languages ?? [],
    internalPackagePrefixes: input.internalPackagePrefixes ?? {},
    maskModuleSpecifiers: input.maskModuleSpecifiers ?? true,
    // OFF for all five languages (see interface docs); not yet consumed.
    maskMembers: input.maskMembers ?? false,
    stripComments: input.stripComments ?? true,
    scrubSecrets: input.scrubSecrets ?? true,
    detectorConfig: input.detectorConfig ?? {},
    sessionSalt,
    hashLength,
    strings: resolveCodeMaskerConfig({
      sessionSalt,
      hashLength,
      ...(input.maskStrings !== undefined ? { maskStrings: input.maskStrings } : {}),
      ...(input.maskPrivateIps !== undefined ? { maskPrivateIps: input.maskPrivateIps } : {}),
      ...(input.internalTlds ? { internalTlds: input.internalTlds } : {}),
      ...(input.internalDomains ? { internalDomains: input.internalDomains } : {}),
      ...(input.maskBucket2 !== undefined ? { maskBucket2: input.maskBucket2 } : {}),
      ...(input.bucket2Patterns ? { bucket2Patterns: input.bucket2Patterns } : {}),
      ...(input.bucket2Substrings ? { bucket2Substrings: input.bucket2Substrings } : {}),
    }),
  };
}
