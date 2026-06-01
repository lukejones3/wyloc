/**
 * In-memory, ephemeral session store for real↔mock mappings.
 *
 * PRIVACY CONTRACT (mirrors the browser extension's model):
 *   • Mappings live ONLY in process memory for the lifetime of the
 *     gateway process. They are NEVER written to disk and NEVER logged.
 *   • When the process exits, they are gone. There is no persistence,
 *     no cache file, no telemetry of values.
 *
 * Scope: the gateway process IS the session. A single Claude Code run is
 * served by one gateway process, so one store per process is the correct
 * "session-scoped" unit. Mocks are globally unique (a deterministic hash
 * of the real value + salt), so sharing one store across requests is safe
 * even with multiple concurrent conversations — the same secret always
 * collapses to the same mock, and distinct secrets never collide.
 *
 * The salt is generated once at construction and used for every swap so
 * repeated secrets map to one stable mock (which is what lets the model
 * track a credential across a prompt, and lets Phase 3 rehydrate).
 */

import { randomBytes } from "node:crypto";
import type { SwapMapping } from "@wyloc/detector";

export class SessionStore {
  /** Per-session salt for deterministic mock derivation. Never logged. */
  private readonly salt: string;
  /** mock → mapping. The reverse index Phase 3 rehydrates from. */
  private readonly byMock = new Map<string, SwapMapping>();

  constructor(salt?: string) {
    this.salt = salt ?? randomBytes(16).toString("hex");
  }

  /** The salt to hand to `buildSwap`. LOCAL ONLY — never log or transmit. */
  get saltValue(): string {
    return this.salt;
  }

  /** Number of distinct mock placeholders currently tracked. */
  get size(): number {
    return this.byMock.size;
  }

  /** Merge new mappings, deduplicated by mock. */
  add(mappings: readonly SwapMapping[]): void {
    for (const m of mappings) {
      if (!this.byMock.has(m.mock)) this.byMock.set(m.mock, m);
    }
  }

  /** Snapshot of all mappings — used by Phase 3 rehydration. */
  all(): SwapMapping[] {
    return [...this.byMock.values()];
  }
}
