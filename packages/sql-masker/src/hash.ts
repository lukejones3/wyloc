import { createHash } from "node:crypto";

/**
 * Deterministic, identifier-safe short hash.
 *
 * Same (input, salt) -> same output, always. Output is lowercase base-36
 * ([0-9a-z]), so it is safe to embed in a SQL identifier. The salt lets a
 * caller make masks unlinkable across sessions (pass a random per-session
 * salt) while staying perfectly consistent within a session; the default
 * empty salt makes masks fully deterministic, which is what tests rely on.
 */
export function shortHash(input: string, salt = "", len = 6): string {
  const digest = createHash("sha256").update(`${salt}:${input}`).digest("hex");
  // Take 64 bits of the digest and base-36 encode for a compact alnum token.
  const n = BigInt(`0x${digest.slice(0, 16)}`);
  return n.toString(36).padStart(len, "0").slice(0, len);
}
