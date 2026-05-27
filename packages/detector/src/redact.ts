/**
 * Redaction helpers — used by the developer UI's "Replace / redact"
 * action (plan Section 11). Pure string transforms; no I/O.
 *
 * The detector NEVER auto-sends redacted text anywhere — these functions
 * just compute what a redacted version would look like so a surface can
 * offer it as a one-click action.
 */

import type { Finding, SecretType } from "./types.js";

/** Placeholder label per secret type, e.g. `[REDACTED_AWS_ACCESS_KEY]`. */
function placeholderFor(type: SecretType): string {
  return `[REDACTED_${type.toUpperCase()}]`;
}

/**
 * Return `text` with every finding's value replaced by a typed
 * placeholder. Findings may be passed in any order.
 */
export function redact(text: string, findings: Finding[]): string {
  if (findings.length === 0) return text;
  // Apply right-to-left so earlier offsets stay valid.
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let result = text;
  for (const f of ordered) {
    result =
      result.slice(0, f.start) +
      placeholderFor(f.type) +
      result.slice(f.end);
  }
  return result;
}

/**
 * Partial mask of a single secret value for inline display, e.g.
 * `AKIA****************` — shows enough to recognise, hides enough to
 * stay safe. Never reveals more than the first 4 characters.
 */
export function maskValue(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  const visible = value.slice(0, 4);
  return visible + "*".repeat(Math.min(value.length - 4, 24));
}
