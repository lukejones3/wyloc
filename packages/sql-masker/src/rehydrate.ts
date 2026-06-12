import type { SessionMap } from "./session.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reverse a masked LLM response back to real identifiers.
 *
 * Only tokens this session actually created are reversed; everything else —
 * including identifiers the model invented (e.g. an index `ix_fact_aa11` or a
 * column it proposes) — passes through untouched. Identifier-boundary matching
 * (no `[A-Za-z0-9_]` on either side) means a mask embedded inside a longer
 * invented name (`ix_<mask>_feed`) is deliberately left masked, per spec: we
 * reverse exact tokens we own, never reach into names we don't.
 *
 * Pure and parser-free: works on arbitrary text (prose + SQL), so it tolerates
 * the non-parseable mix an LLM returns.
 */
export function rehydrate(text: string, session: SessionMap): string {
  const masks = session.masksByLengthDesc();
  if (masks.length === 0) return text;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${masks.map(escapeRegex).join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
  return text.replace(pattern, (m) => session.realFor(m) ?? m);
}
