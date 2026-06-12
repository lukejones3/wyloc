import type { IdentifierKind, MaskEntry } from "./types.js";

/**
 * In-memory, bidirectional real<->mask map for a single masking session.
 *
 * RAM-ONLY INVARIANT: this object is never serialized to disk and never logged.
 * It mirrors the gateway's RAM-only secret map. It exists only to (a) keep masks
 * consistent while masking one query and (b) drive rehydration of the model's
 * response. There is deliberately no toJSON / save method.
 */
export class SessionMap {
  private readonly realToMask = new Map<string, string>();
  private readonly maskToReal = new Map<string, string>();
  private readonly kinds = new Map<string, IdentifierKind>();

  /**
   * Record a mapping. Idempotent for an identical (real,mask) pair. Guards
   * against two different reals colliding on one mask by suffixing a counter,
   * and returns the mask actually stored (callers should use the return value).
   */
  add(kind: IdentifierKind, real: string, mask: string): string {
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
      kind: this.kinds.get(mask) ?? "alias",
      real,
      mask,
    }));
  }

  get size(): number {
    return this.maskToReal.size;
  }
}
