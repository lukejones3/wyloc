/**
 * Layer 3: structural pattern detection.
 *
 * Catches credential-shaped *assignments* that no vendor pattern would
 * match — `SECRET_KEY=...`, `export DB_PASSWORD=...`, `.env` blocks, and
 * JSON/YAML credential objects. These are emitted at medium confidence
 * and the context + value heuristics decide whether they escalate.
 */

import { CONTEXT_KEYWORDS } from "../config.js";
import { shannonEntropy, hasSecretLikeCharMix } from "./entropy.js";

export interface StructuralMatch {
  ruleId: string;
  /** The full matched assignment, e.g. `API_KEY=abc123`. */
  fullText: string;
  /** Just the value portion (right-hand side, unquoted). */
  value: string;
  start: number;
  end: number;
  /** The key/identifier on the left-hand side, lowercased. */
  key: string;
}

/**
 * Matches assignment forms:
 *   KEY=value
 *   KEY="value"
 *   KEY: value      (yaml-ish)
 *   export KEY=value
 * The key must look like an identifier; the value must be non-trivial.
 */
const ASSIGNMENT_RE =
  /(?:^|\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.\-]*)\s*[=:]\s*(['"]?)([^\n'"]{6,})\2/g;

/** Keys whose name alone indicates the value is sensitive. */
function keyIsSensitive(key: string): boolean {
  return CONTEXT_KEYWORDS.some((kw) => key.includes(kw));
}

/**
 * Decide whether a structural assignment is worth surfacing. We require
 * EITHER a sensitive-looking key OR a value that itself looks secret-like
 * (decent entropy + mixed character classes). This keeps ordinary config
 * (`PORT=3000`, `NODE_ENV=production`) from generating noise.
 */
function isWorthSurfacing(key: string, value: string): boolean {
  if (keyIsSensitive(key)) return true;
  if (
    value.length >= 16 &&
    hasSecretLikeCharMix(value) &&
    shannonEntropy(value) >= 3.5
  ) {
    return true;
  }
  return false;
}

export function findStructuralMatches(text: string): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  ASSIGNMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASSIGNMENT_RE.exec(text)) !== null) {
    const rawKey = m[1] ?? "";
    const value = (m[3] ?? "").trim();
    const key = rawKey.toLowerCase();
    if (value.length === 0) continue;
    if (!isWorthSurfacing(key, value)) continue;

    // Compute offsets of the value within the original text. The leading
    // (?:^|\n)\s* may have consumed characters before the key.
    const matchText = m[0];
    const valueOffsetInMatch = matchText.lastIndexOf(value);
    const start = m.index + valueOffsetInMatch;
    matches.push({
      ruleId: "structural.assignment",
      fullText: matchText.trim(),
      value,
      start,
      end: start + value.length,
      key,
    });
  }
  return matches;
}
