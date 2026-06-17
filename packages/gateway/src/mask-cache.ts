/**
 * Per-session content cache for the masking passes.
 *
 * Agentic clients resend the FULL conversation history every turn (all prior
 * messages + every file the agent read), so without caching each masking pass
 * re-scans/re-parses the entire payload every turn — per-turn cost grows with
 * session length. This cache makes any content already processed this session a
 * cheap hit, so real work is proportional to NEW content per turn.
 *
 * SAFETY INVARIANT: masks are deterministic (derived from the shared session
 * salt) and the session store dedups by real value, so a cached result is
 * byte-identical to a fresh compute — caching changes COST ONLY, never output.
 * (Mappings produced on the first compute are already folded into the shared
 * store, which is session-lived; a cache hit reuses them via the store.)
 *
 * Keyed by a content hash so large file bodies don't bloat the key set; a soft
 * FIFO cap bounds memory over very long sessions.
 */
import { createHash } from "node:crypto";

const MAX_ENTRIES = 4096;

export class MaskCache {
  private hits = 0;
  private misses = 0;
  private readonly map = new Map<string, unknown>();

  private key(input: string): string {
    return createHash("sha256").update(input).digest("base64");
  }

  /** Memoize a synchronous masking compute keyed by the input content. */
  memo<T>(input: string, compute: () => T): T {
    const k = this.key(input);
    const hit = this.map.get(k);
    if (hit !== undefined) { this.hits++; return hit as T; }
    this.misses++;
    const v = compute();
    this.put(k, v);
    return v;
  }

  /** Memoize an async masking compute keyed by the input content. */
  async memoAsync<T>(input: string, compute: () => Promise<T>): Promise<T> {
    const k = this.key(input);
    const hit = this.map.get(k);
    if (hit !== undefined) { this.hits++; return hit as T; }
    this.misses++;
    const v = await compute();
    this.put(k, v);
    return v;
  }

  private put(k: string, v: unknown): void {
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(k, v);
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }
}
