/**
 * Layer 4 (context gating) + Layer 5 (allowlist / suppression).
 *
 * Context does not produce findings of its own — it adjusts the
 * confidence of findings from layers 1-3 and infers the environment
 * (prod vs dev) that the policy engine needs.
 */

import type { Confidence, Environment } from "../types.js";
import { CONTEXT_KEYWORDS, PROD_MARKERS, DEV_MARKERS } from "../config.js";

/** Lowercased slice of text surrounding a match, used for keyword checks. */
function windowAround(
  text: string,
  start: number,
  end: number,
  radius: number,
): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return text.slice(from, to).toLowerCase();
}

/** True if any context keyword appears within `radius` chars of the match. */
export function hasNearbyContext(
  text: string,
  start: number,
  end: number,
  radius: number,
): boolean {
  const w = windowAround(text, start, end, radius);
  return CONTEXT_KEYWORDS.some((kw) => w.includes(kw));
}

/**
 * Infer environment from markers near the match. Prod markers win ties
 * only when no dev marker is present — when both appear we stay
 * `unknown` rather than guess wrong (a dev marker next to a real prod
 * key would otherwise mask it).
 */
export function inferEnvironment(
  text: string,
  start: number,
  end: number,
  radius: number,
): Environment {
  const w = windowAround(text, start, end, radius);
  const hasProd = PROD_MARKERS.some((m) => w.includes(m));
  const hasDev = DEV_MARKERS.some((m) => w.includes(m));
  if (hasProd && !hasDev) return "prod";
  if (hasDev && !hasProd) return "dev";
  return "unknown";
}

/**
 * Layer 5: is the candidate suppressed by the allowlist? A match is
 * suppressed if any allowlist substring appears within the match itself
 * or immediately around it (a tight window — we don't want a `test`
 * three lines away to mask a real key).
 */
export function isAllowlisted(
  text: string,
  start: number,
  end: number,
  value: string,
  allowlist: readonly string[],
): boolean {
  const tightWindow = windowAround(text, start, end, 12);
  const valueLower = value.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return valueLower.includes(e) || tightWindow.includes(e);
  });
}

/** One step up the confidence ladder. */
export function raiseConfidence(c: Confidence): Confidence {
  if (c === "low") return "medium";
  if (c === "medium") return "high";
  return "high";
}

/** One step down the confidence ladder. */
export function lowerConfidence(c: Confidence): Confidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}
