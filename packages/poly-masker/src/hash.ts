import { createHash } from "node:crypto";

/**
 * Deterministic short hash for mask suffixes — identical algorithm to
 * @wyloc/code-masker's (not exported there; 12 lines are cheaper than widening
 * that package's public API). Same (input, salt) → same output, base-36
 * lowercase so the result is a valid identifier fragment in every target
 * language.
 */
export function shortHash(input: string, salt = "", len = 6): string {
  const digest = createHash("sha256").update(`${salt}:${input}`).digest("hex");
  const n = BigInt(`0x${digest.slice(0, 16)}`);
  return n.toString(36).padStart(len, "0").slice(0, len);
}
