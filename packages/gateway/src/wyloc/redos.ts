/**
 * Static catastrophic-backtracking (ReDoS) detection for raw-regex patterns.
 *
 * Raw patterns run on RE2 at runtime (linear time, no backtracking), so this is
 * defense-in-depth + a fast, specific LOAD-TIME error: a customer gets
 * "this looks like (a+)+ which can hang" up front rather than a mysterious slow
 * pattern. The dominant catastrophic class is a quantifier applied to a group
 * that itself contains an unbounded quantifier — (a+)+, (a*)*, (.*)*, (\d+)* —
 * which this detects via a star-height walk over the source.
 *
 * Pure, no dependencies. Heuristic (not a full regex parser): it errs toward
 * flagging the well-known dangerous shapes and never executes the pattern.
 */

/** True for a quantifier that can repeat unboundedly: * + {n,} {n,m} with m≥2. */
function unboundedQuantifierAt(src: string, i: number): { unbounded: boolean; len: number } | null {
  const c = src[i];
  if (c === "*" || c === "+") return { unbounded: true, len: 1 };
  if (c === "?") return { unbounded: false, len: 1 };
  if (c === "{") {
    const m = /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return null;
    const max = m[3] !== undefined && m[3] !== "" ? Number(m[3]) : Infinity;
    const hasComma = m[2] !== undefined;
    // {n,} or {n,m} with m≥2 (or open) can repeat; {n} and {n,1}/{0,1} cannot blow up.
    const unbounded = hasComma && max >= 2;
    return { unbounded, len: m[0].length };
  }
  return null;
}

/**
 * Returns a human-readable reason if `source` contains a likely catastrophic
 * construct, else null.
 */
export function findReDoSRisk(source: string): string | null {
  // Per open group: did its body contain an unbounded quantifier?
  const groupHadUnbounded: boolean[] = [];
  // Did the most-recently-CLOSED group's body contain an unbounded quantifier?
  let lastClosedHadUnbounded = false;
  let prevWasGroupClose = false;

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;

    if (c === "\\") { i += 2; prevWasGroupClose = false; continue; }

    if (c === "[") { // character class — skip to closing ]
      i++;
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      prevWasGroupClose = false;
      continue;
    }

    if (c === "(") { groupHadUnbounded.push(false); prevWasGroupClose = false; i++; continue; }

    if (c === ")") {
      lastClosedHadUnbounded = groupHadUnbounded.pop() ?? false;
      prevWasGroupClose = true;
      i++;
      continue;
    }

    const q = unboundedQuantifierAt(source, i);
    if (q) {
      if (q.unbounded && prevWasGroupClose && lastClosedHadUnbounded) {
        return `nested unbounded quantifier near index ${i} (e.g. \`(a+)+\`) — catastrophic backtracking risk`;
      }
      // Record that the enclosing group now contains an unbounded quantifier.
      if (q.unbounded && groupHadUnbounded.length > 0) {
        groupHadUnbounded[groupHadUnbounded.length - 1] = true;
      }
      i += q.len;
      prevWasGroupClose = false;
      continue;
    }

    prevWasGroupClose = false;
    i++;
  }
  return null;
}
