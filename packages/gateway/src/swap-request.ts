/**
 * Request-path real→mock swap (provider-agnostic).
 *
 * Replaces detected secrets in user/system/assistant TEXT with WYLOC_MOCK_
 * placeholders using the shared @wyloc/detector engine (`scan` + `buildSwap`).
 * Detection is NOT reimplemented here, and neither is the wire format: WHICH
 * strings are maskable and WHERE the directive goes is delegated to the
 * `ProviderAdapter`, so this same swap runs for Anthropic and OpenAI bodies.
 * Tool-call structure is never touched (the adapter's walk skips it).
 *
 * Determinism: the session salt makes the same secret always map to the same
 * mock, so re-sending conversation history (which on later turns may carry a
 * real value Phase 3 rehydrated) re-swaps to the identical mock.
 */

import { scan, buildSwap, type SecretType } from "@wyloc/detector";
import type { ProviderAdapter } from "./adapters/types.js";

/** The reserved placeholder marker. Findings matching it are already-masked
 *  values (from a prior pass or re-sent turn) and must never be re-masked. */
export const MOCK_MARKER = "WYLOC_MOCK_";
import type { GatewayConfig } from "./config.js";
import type { SessionStore } from "./session.js";
import type { MaskCache } from "./mask-cache.js";

export interface SwapOutcome {
  /** Bytes to forward upstream (rewritten if anything was swapped). */
  body: Buffer;
  /** True if the body parsed as JSON and was walked. */
  processed: boolean;
  /** Total findings detected across all user text. */
  detected: number;
  /** Distinct mock placeholders written into the outbound body. */
  swapCount: number;
  /** Whether the verbatim-echo system directive was injected. */
  injected: boolean;
  /** Coarse secret types — the ONLY detail safe to log. */
  types: SecretType[];
  /**
   * Verification for metadata-only logs:
   *   mockCount — how many WYLOC_MOCK_ placeholders are in the outbound body.
   *   leaked    — whether any swapped secret survived in text WE REWROTE
   *               (must be false). Scoped to the rewritten pieces, not the
   *               whole body, so a secret that legitimately remains inside
   *               an untouched tool_result does not false-positive. The
   *               value itself is never logged — only this boolean.
   */
  mockCount: number;
  leaked: boolean;
}

/** Mutable accumulator threaded through the walk. */
interface Acc {
  detected: number;
  types: SecretType[];
  /** Distinct mocks written this request. */
  mocks: Set<string>;
  /**
   * True if any real secret survived in a string we rewrote. Computed
   * per-piece and discarded; reals are never stored beyond this check.
   */
  leaked: boolean;
}

/** Deterministic result of scanning one string — cacheable (depends only on
 *  the text + the session salt, both stable within a session). */
interface SwapResult {
  out: string;
  detected: number;
  types: SecretType[];
  mocks: string[];
  leaked: boolean;
}

/** Scan one string, swap any secrets, record mappings into the store. */
function computeSwap(text: string, config: GatewayConfig, store: SessionStore): SwapResult {
  if (text.length === 0) return { out: text, detected: 0, types: [], mocks: [], leaked: false };
  const result = scan(text, config.detector);
  // Never re-mask an existing WYLOC_MOCK_ placeholder. A prior pass (env/SQL/code,
  // or a re-sent earlier turn) may have already swapped a value to a mock; the
  // detector can then re-match that mock (e.g. as an .env assignment value),
  // producing a mock-of-a-mock chain that one rehydration pass can't reverse.
  // A real secret never contains our marker, so this filter is safe.
  const findings = result.findings.filter((f) => !f.value.includes(MOCK_MARKER));
  if (findings.length === 0) return { out: text, detected: 0, types: [], mocks: [], leaked: false };

  const { swappedText, mappings } = buildSwap(text, findings, store.saltValue);
  store.add(mappings);

  let leaked = false;
  const mocks: string[] = [];
  for (const m of mappings) {
    mocks.push(m.mock);
    // Leak guard, scoped to THIS rewritten string: the real value must not
    // survive the swap. (Deterministic for a given text, so safe to cache.)
    if (m.real.length > 0 && swappedText.includes(m.real)) leaked = true;
  }
  return { out: swappedText, detected: findings.length, types: findings.map((f) => f.type), mocks, leaked };
}

/**
 * Swap secrets out of a request body, using `adapter` to decide which strings
 * are maskable and where the directive goes.
 *
 * If the body is not parseable JSON it is returned untouched
 * (`processed: false`) — we never risk corrupting a request we don't
 * understand. The detector config and session store come from the gateway
 * config seam; nothing here is hardcoded.
 */
/** Detector swap on an ALREADY-PARSED request object, in place. Returns the
 *  metrics; does NOT inject the directive or serialize (the proxy does both
 *  once at the end of the parse-once pipeline). */
export function applyDetectorSwap(
  adapter: ProviderAdapter,
  parsed: unknown,
  config: GatewayConfig,
  store: SessionStore,
  cache: MaskCache,
): Promise<{ detected: number; swapCount: number; types: SecretType[]; leaked: boolean }> {
  const acc: Acc = { detected: 0, types: [], mocks: new Set(), leaked: false };
  // Cache by content: re-sent history strings are a cheap hit (their mappings
  // are already in the store), so only NEW text is scanned. The cached result
  // is replayed into `acc` for the same per-request accounting.
  return adapter.forEachText(parsed, (text) => {
    const r = cache.memo(text, () => computeSwap(text, config, store));
    acc.detected += r.detected;
    for (const t of r.types) acc.types.push(t);
    for (const mck of r.mocks) acc.mocks.add(mck);
    if (r.leaked) acc.leaked = true;
    return r.out;
  }).then(() => ({ detected: acc.detected, swapCount: acc.mocks.size, types: acc.types, leaked: acc.leaked }));
}

/** Buffer→Buffer wrapper (parse, swap, inject, serialize). Retained for
 *  standalone/test callers; the proxy uses applyDetectorSwap (parse once). */
export async function runDetectorSwap(
  adapter: ProviderAdapter,
  raw: Buffer,
  config: GatewayConfig,
  store: SessionStore,
  cache: MaskCache,
): Promise<SwapOutcome> {
  const passthrough = (): SwapOutcome => ({
    body: raw, processed: false, detected: 0, swapCount: 0,
    injected: false, types: [], mockCount: 0, leaked: false,
  });

  if (raw.length === 0) return passthrough();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return passthrough();
  }
  if (parsed === null || typeof parsed !== "object") return passthrough();

  const r = await applyDetectorSwap(adapter, parsed, config, store, cache);
  if (r.detected === 0) return { ...passthrough(), processed: true };

  const mockCount = (JSON.stringify(parsed).match(/WYLOC_MOCK_/g) ?? []).length;
  let injected = false;
  if (config.injectSystemPrompt) {
    adapter.injectDirective(parsed);
    injected = true;
  }
  return {
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    processed: true,
    detected: r.detected,
    swapCount: r.swapCount,
    injected,
    types: r.types,
    mockCount,
    leaked: r.leaked,
  };
}
