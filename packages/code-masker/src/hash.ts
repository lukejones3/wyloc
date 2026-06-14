import { createHash } from "node:crypto";

/**
 * Deterministic, identifier-safe short hash. Shared philosophy with
 * @wyloc/sql-masker: same (input, salt) -> same output, lowercase base-36
 * ([0-9a-z]) so it is safe to embed in a JS/TS identifier. The salt makes
 * masks unlinkable across sessions while staying consistent within one; the
 * default empty salt makes masks fully deterministic, which tests rely on.
 */
export function shortHash(input: string, salt = "", len = 6): string {
  const digest = createHash("sha256").update(`${salt}:${input}`).digest("hex");
  const n = BigInt(`0x${digest.slice(0, 16)}`);
  return n.toString(36).padStart(len, "0").slice(0, len);
}
