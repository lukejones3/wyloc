/**
 * Token-boundary streaming rehydration.
 *
 * A mock placeholder (e.g. `WYLOC_MOCK_AWS_ACCESS_KEY_1D9AD1`) can be
 * split across several streamed `text_delta` events — the upstream emits
 * the assistant's text in arbitrary slices, so "WYLOC_MOCK_AWS" might
 * arrive in one delta and "_ACCESS_KEY_1D9AD1" in the next. A blunt
 * find-replace on each delta would miss the split token and stream the
 * mock through to the user.
 *
 * `RehydrationStream` solves this by buffering on token boundaries:
 *   • text is accumulated into `pending`
 *   • on each push we flush everything EXCEPT a trailing suffix that could
 *     still grow into a `WYLOC_MOCK_` token (`holdPoint`)
 *   • complete mocks in the flushed prefix are rehydrated to their real
 *     values; the held suffix waits for the next delta
 *   • `flush()` drains whatever remains when the content block ends
 *
 * This keeps the stream progressive (we hold back at most a partial token,
 * ~30 chars, never the whole response) while guaranteeing a mock is never
 * emitted half-rewritten.
 *
 * Rehydration is identifier-aware (ported from the browser extension's
 * `rehydrateSmart`): when a mock sits in identifier position — e.g.
 * `os.environ["WYLOC_MOCK_…"]` — we leave it as the mock rather than
 * inject a real secret as a variable/key name. To make that decision work
 * across delta boundaries we carry a small left-context window of the
 * already-flushed raw text.
 */

import type { MockMapping } from "./session.js";

const MARKER = "WYLOC_MOCK_";
/** Characters that can appear in a mock after the marker (TYPE + _ + ID). */
const TOKEN_CHARS = /^[A-Z0-9_]*$/;
/** Left-context window kept for identifier detection across deltas. */
const CTX = 16;

/**
 * Index from which the suffix of `s` could still extend into a complete
 * `WYLOC_MOCK_` token, and must therefore be held back. Returns `s.length`
 * when nothing needs holding (the whole string is safe to flush).
 */
export function holdPoint(s: string, mocks?: readonly string[]): number {
  let hold = s.length;

  // Case A: a marker occurrence whose token-run reaches the end of `s` with
  // no terminator yet — it could still grow, so hold from there.
  const idx = s.lastIndexOf(MARKER);
  if (idx !== -1 && TOKEN_CHARS.test(s.slice(idx + MARKER.length))) {
    hold = Math.min(hold, idx);
  }
  // Case B: the longest suffix of `s` that is a prefix of the marker itself
  // (the marker hasn't fully arrived yet), e.g. "...WYLOC_MO".
  for (let k = Math.min(MARKER.length - 1, s.length); k >= 1; k--) {
    if (s.endsWith(MARKER.slice(0, k))) {
      hold = Math.min(hold, s.length - k);
      break;
    }
  }
  // Case C: the longest suffix of `s` that is a proper prefix of any known
  // mock — so a split SQL mask (`mart_a1` → `mart_a1b2c3`) is held until
  // complete. No-op when `mocks` is omitted (preserves the 1-arg behavior).
  if (mocks) {
    for (const mock of mocks) {
      for (let k = Math.min(mock.length - 1, s.length); k >= 1; k--) {
        if (s.endsWith(mock.slice(0, k))) {
          hold = Math.min(hold, s.length - k);
          break;
        }
      }
    }
  }
  return hold;
}

/** Browser-parity identifier-position heuristic. */
function isIdentifierContext(before: string, after: string): boolean {
  return (
    /(?:environ|getenv|process\.env|env)\s*[\[.]\s*['"]?$/.test(before) ||
    /process\.env\.$/.test(before) ||
    (/[.[]\s*$/.test(before) && !/^['"]/.test(after))
  );
}

/**
 * Rehydrate mocks that begin within `chunk`, using `leftCtx` (already-
 * flushed raw text) only as context for the identifier heuristic. Mocks
 * never span the chunk boundary because partial tokens are held, so every
 * mock seen here is fully contained in `chunk`. Returns the transformed
 * chunk (the `leftCtx` prefix is never modified and is sliced back off).
 */
function rehydrateChunk(
  leftCtx: string,
  chunk: string,
  mappings: readonly MockMapping[],
): string {
  // Fast path: skip only when there is no marker AND no non-marker (SQL) mock
  // that could appear without it. SQL masks keep their semantic shape, so they
  // do not carry the WYLOC_MOCK_ marker and must not be gated on it.
  const hasSqlMocks = mappings.some((m) => !m.mock.startsWith(MARKER));
  if (chunk.indexOf(MARKER) === -1 && !hasSqlMocks) return chunk;
  const combined = leftCtx + chunk;
  const gate = leftCtx.length;
  let result = "";
  let i = 0;

  while (i < combined.length) {
    // Find the earliest mock occurrence at or after i (longest on ties).
    let bestAt = -1;
    let bestMock: MockMapping | null = null;
    for (const m of mappings) {
      if (!m.mock) continue;
      const at = combined.indexOf(m.mock, i);
      if (at === -1) continue;
      if (
        bestAt === -1 ||
        at < bestAt ||
        (at === bestAt && m.mock.length > (bestMock?.mock.length ?? 0))
      ) {
        bestAt = at;
        bestMock = m;
      }
    }

    if (bestAt === -1 || bestMock === null) {
      result += combined.slice(i);
      break;
    }

    const end = bestAt + bestMock.mock.length;
    if (bestAt < gate) {
      // Occurrence sits in the carried context — already handled before;
      // copy it through untouched and move on.
      result += combined.slice(i, end);
      i = end;
      continue;
    }

    result += combined.slice(i, bestAt);
    const before = combined.slice(Math.max(0, bestAt - CTX), bestAt);
    const after = combined.slice(end, end + 4);
    result += isIdentifierContext(before, after) ? bestMock.mock : bestMock.real;
    i = end;
  }

  return result.slice(gate);
}

export class RehydrationStream {
  /** Held tail (raw mock form) that could still complete a token. */
  private pending = "";
  /** Last <=CTX raw chars already flushed, for identifier context. */
  private leftCtx = "";

  private readonly mockStrings: readonly string[];

  constructor(private readonly mappings: readonly MockMapping[]) {
    this.mockStrings = mappings.map((m) => m.mock);
  }

  /** Feed text from a `text_delta`; returns rehydrated text to emit now. */
  pushText(text: string): string {
    this.pending += text;
    const hp = holdPoint(this.pending, this.mockStrings);
    const flushRaw = this.pending.slice(0, hp);
    this.pending = this.pending.slice(hp);
    return this.emit(flushRaw);
  }

  /** Drain remaining buffer when the content block (or stream) ends. */
  flush(): string {
    const flushRaw = this.pending;
    this.pending = "";
    return this.emit(flushRaw);
  }

  /** Reset per-block state at a content_block_start / _stop boundary. */
  resetBlock(): void {
    this.pending = "";
    this.leftCtx = "";
  }

  private emit(flushRaw: string): string {
    if (flushRaw.length === 0) return "";
    const out = rehydrateChunk(this.leftCtx, flushRaw, this.mappings);
    this.leftCtx = (this.leftCtx + flushRaw).slice(-CTX);
    return out;
  }
}
