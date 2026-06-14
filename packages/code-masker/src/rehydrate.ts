import type { SessionMap } from "./session.js";
import type { MaskKind } from "./types.js";

/**
 * Reverse a masked LLM response back to real names using a session map.
 *
 * Two invariants from the prompt:
 *   1. ONLY reverse tokens we created. Identifiers the LLM *invented* (new
 *      function/variable names it proposes, library calls, etc.) are passed
 *      through untouched — we simply never match them, because we only look for
 *      masks that are in the session.
 *   2. Replace longest-first so a shorter mask that is a prefix of a longer one
 *      (e.g. `Class_ab` vs `Class_ab_1`) can't corrupt it.
 *
 * Identifier-shaped masks (class/function/import/member/…) are reversed on word
 * boundaries so an invented name that *embeds* a mask (e.g. `Class_abHelper`)
 * is left alone. String/secret/path/host masks live inside string literals and
 * are reversed by plain substring replacement.
 */

const IDENTIFIER_KINDS = new Set<MaskKind>([
  "class", "function", "interface", "type", "enum", "namespace", "member", "import",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rehydrate(text: string, session: SessionMap): string {
  if (session.size === 0) return text;
  // entries() already gives one row per mask; sort longest-first.
  const entries = session.entries().sort((a, b) => b.mask.length - a.mask.length);
  let out = text;
  for (const { mask, real, kind } of entries) {
    if (!mask) continue;
    if (IDENTIFIER_KINDS.has(kind)) {
      // Word-boundary reverse so we never rewrite a mask embedded in a longer,
      // LLM-invented identifier.
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_$])${escapeRegex(mask)}(?![A-Za-z0-9_$])`, "g"),
        real,
      );
    } else {
      out = out.split(mask).join(real);
    }
  }
  return out;
}
