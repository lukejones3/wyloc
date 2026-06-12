import { scan, buildSwap } from "@wyloc/detector";
import type { MaskerConfig } from "./config.js";
import { shortHash } from "./hash.js";

/** One real→mask pair to record for rehydration. */
export interface LiteralMapping {
  real: string;
  mask: string;
}

export interface LiteralScrubResult {
  /** old literal value -> scrubbed value, for the AST rewrite (exact-match). */
  valueMap: Record<string, string>;
  /** real -> mask pairs to record in the session for rehydration. */
  mappings: LiteralMapping[];
}

/**
 * The literal/value scrubbing pass — a separate concern from identifier masking.
 *
 * For each distinct string-literal value in the query it applies, in order:
 *   1. org blocklist substrings (e.g. a federal-staffing company list) → the
 *      whole literal is redacted to an opaque token;
 *   2. PII / org value patterns (e.g. email, SSN) → whole literal redacted;
 *   3. detector secrets embedded in the literal (API key, DB URL, …) → the
 *      secret substring is replaced by the detector's structural mock, and the
 *      per-secret mapping (secret→mock) is what gets recorded for rehydration.
 *
 * Identifier masking is NOT done here. This pass only ever rewrites literal
 * *values*, so it cannot corrupt SQL structure.
 */
export function scrubLiterals(values: readonly string[], cfg: MaskerConfig): LiteralScrubResult {
  const valueMap: Record<string, string> = {};
  const mappings: LiteralMapping[] = [];
  const salt = cfg.sessionSalt;

  const matchesSubstring = (v: string): boolean => {
    const lower = v.toLowerCase();
    return cfg.sensitiveValueSubstrings.some(
      (s) => s.length > 0 && lower.includes(s.toLowerCase()),
    );
  };
  const matchesPattern = (v: string): boolean =>
    cfg.sensitiveValuePatterns.some((re) => re.test(v));

  for (const v of values) {
    if (v.length === 0 || v in valueMap) continue;

    if (matchesSubstring(v)) {
      const mask = `wyloc_blocked_${shortHash(v, salt, cfg.hashLength)}`;
      valueMap[v] = mask;
      mappings.push({ real: v, mask });
      continue;
    }
    if (matchesPattern(v)) {
      const mask = `wyloc_redacted_${shortHash(v, salt, cfg.hashLength)}`;
      valueMap[v] = mask;
      mappings.push({ real: v, mask });
      continue;
    }
    if (cfg.scrubSecretsInLiterals) {
      const findings = scan(v, cfg.detectorConfig).findings;
      if (findings.length > 0) {
        const swap = buildSwap(v, findings, salt);
        if (swap.swappedText !== v) {
          valueMap[v] = swap.swappedText;
          // Reverse the actual secret→mock pairs, not the whole literal: the
          // model may echo just the mock token, which these mappings restore.
          for (const m of swap.mappings) mappings.push({ real: m.real, mask: m.mock });
        }
      }
    }
  }

  return { valueMap, mappings };
}
