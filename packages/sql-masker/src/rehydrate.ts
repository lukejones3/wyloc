import type { SessionMap } from "./session.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reverse a masked LLM response back to real identifiers and values.
 *
 * Two channels, because they have different shapes:
 *
 *  • Literal values (kind "literal") — secrets/PII/blocklist values, which may
 *    contain spaces and punctuation. Reversed by plain longest-first replace.
 *
 *  • Identifier masks (tables/schemas/columns/aliases) — reversed with
 *    identifier-boundary matching, so a mask embedded inside an identifier the
 *    model invented (e.g. an index `ix_<mask>_feed`, a proposed column) is left
 *    masked, per spec: reverse exact tokens we own, never reach into names we
 *    don't.
 *
 * Only tokens this session created are reversed; everything else passes through.
 * Pure and parser-free, so it tolerates the prose+SQL mix an LLM returns.
 */
export function rehydrate(text: string, session: SessionMap): string {
  const entries = session.entries();
  if (entries.length === 0) return text;
  let out = text;

  // 1. Literal values — plain replace, longest mask first.
  const literals = entries
    .filter((e) => e.kind === "literal")
    .sort((a, b) => b.mask.length - a.mask.length);
  for (const e of literals) {
    if (e.mask.length > 0) out = out.split(e.mask).join(e.real);
  }

  // 2. Identifier masks — boundary-aware alternation.
  const ids = entries.filter((e) => e.kind !== "literal");
  if (ids.length > 0) {
    const map = new Map(ids.map((e) => [e.mask, e.real]));
    const masks = ids.map((e) => e.mask).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])(?:${masks.map(escapeRegex).join("|")})(?![A-Za-z0-9_])`,
      "g",
    );
    out = out.replace(pattern, (m) => map.get(m) ?? m);
  }

  return out;
}
