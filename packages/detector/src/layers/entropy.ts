/**
 * Entropy utilities for Layer 2 detection.
 *
 * High Shannon entropy is a weak signal on its own — random-looking
 * strings are everywhere in code (hashes, UUIDs, minified output). The
 * scanner therefore treats entropy findings as low/medium confidence and
 * leans on the context layer before surfacing them.
 */

/** Shannon entropy in bits per character. Range ~0 (uniform) to ~6+ (random). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * A token candidate extracted from free text, with its position preserved
 * so the scanner can map it back to an offset in the original string.
 */
export interface TokenSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Extract candidate secret-shaped tokens. A token is a run of characters
 * from the secret alphabet (alphanumerics plus the symbols common in
 * encoded keys). Whitespace, quotes, and most punctuation are delimiters.
 */
export function extractTokens(text: string, minLength: number): TokenSpan[] {
  const spans: TokenSpan[] = [];
  // Secret alphabet: base64/base64url/hex-ish plus a few key symbols.
  const tokenRe = /[A-Za-z0-9\-_+/=.]{1,}/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const t = m[0];
    if (t.length >= minLength) {
      spans.push({ text: t, start: m.index, end: m.index + t.length });
    }
  }
  return spans;
}

/**
 * Heuristic: does this token look like a hash/UUID rather than a secret?
 * Pure-hex strings of common digest lengths and canonical UUIDs are
 * extremely common and rarely sensitive — we down-weight them hard.
 */
export function looksLikeHashOrUuid(token: string): boolean {
  const hexDigestLengths = new Set([32, 40, 56, 64, 96, 128]);
  if (/^[0-9a-f]+$/i.test(token) && hexDigestLengths.has(token.length)) {
    return true;
  }
  // Canonical UUID v1-v5.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
  ) {
    return true;
  }
  return false;
}

/**
 * Heuristic: does the token look like an identifier or joined config
 * key rather than a secret? Tokens like `DATABASE_URL`, `MAX_RETRY=5`,
 * or `user.profile.name` decompose cleanly into separator-delimited
 * sub-words. A real secret does not — its randomness has no word breaks.
 *
 * We split on `_ - . =` and check whether the resulting parts look like
 * ordinary words/values: short, or single-character-class. If most parts
 * are word-like, the token is an identifier, not a credential.
 */
export function looksLikeIdentifier(token: string): boolean {
  const parts = token.split(/[_\-.=]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;
  const wordLike = parts.filter((p) => {
    if (p.length <= 6) return true; // short fragment
    const classes = [
      /[a-z]/.test(p),
      /[A-Z]/.test(p),
      /[0-9]/.test(p),
    ].filter(Boolean).length;
    return classes <= 1; // single character class -> word-like
  }).length;
  return wordLike / parts.length >= 0.6;
}

/**
 * Heuristic: does the token have the *character mix* of a real secret?
 * Genuine keys mix upper, lower, and digits. A token that is all one
 * class (e.g. an all-lowercase English-ish word, or an all-digit id) is
 * very unlikely to be a credential even at borderline entropy.
 */
export function hasSecretLikeCharMix(token: string): boolean {
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
  return classes >= 2;
}
