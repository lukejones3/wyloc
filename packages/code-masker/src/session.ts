import type { MaskKind, MaskEntry } from "./types.js";

/**
 * In-memory, bidirectional real<->mask map for a single masking session.
 *
 * RAM-ONLY INVARIANT: never serialized to disk, never logged. Mirrors the
 * gateway's RAM-only secret map and @wyloc/sql-masker's SessionMap. It exists
 * only to (a) keep masks consistent while masking one file and (b) drive
 * rehydration of the model's response. There is deliberately no toJSON / save.
 */
export class SessionMap {
  private readonly realToMask = new Map<string, string>();
  private readonly maskToReal = new Map<string, string>();
  private readonly kinds = new Map<string, MaskKind>();

  /**
   * Record a mapping. Idempotent for an identical real value (returns the mask
   * already stored). Guards against two different reals colliding on one mask
   * by suffixing a counter, and returns the mask actually stored — callers MUST
   * use the return value so every reference is renamed to the same token.
   */
  add(kind: MaskKind, real: string, mask: string): string {
    const existing = this.realToMask.get(real);
    if (existing !== undefined) return existing;

    let unique = mask;
    let n = 1;
    while (this.maskToReal.has(unique) && this.maskToReal.get(unique) !== real) {
      unique = `${mask}_${n++}`;
    }
    this.realToMask.set(real, unique);
    this.maskToReal.set(unique, real);
    this.kinds.set(unique, kind);
    return unique;
  }

  maskFor(real: string): string | undefined {
    return this.realToMask.get(real);
  }

  realFor(mask: string): string | undefined {
    return this.maskToReal.get(mask);
  }

  /** All masks, longest first — the order rehydration needs to avoid partial overlaps. */
  masksByLengthDesc(): string[] {
    return [...this.maskToReal.keys()].sort((a, b) => b.length - a.length);
  }

  entries(): MaskEntry[] {
    return [...this.maskToReal.entries()].map(([mask, real]) => ({
      kind: this.kinds.get(mask) ?? "string",
      real,
      mask,
    }));
  }

  get size(): number {
    return this.maskToReal.size;
  }
}
