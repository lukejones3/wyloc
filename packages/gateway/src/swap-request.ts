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
import type { GatewayConfig } from "./config.js";
import type { SessionStore } from "./session.js";

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

/** Scan one string, swap any secrets, record mappings. Returns new text. */
function swapText(text: string, config: GatewayConfig, store: SessionStore, acc: Acc): string {
  if (text.length === 0) return text;
  const result = scan(text, config.detector);
  if (result.findings.length === 0) return text;

  const { swappedText, mappings } = buildSwap(text, result.findings, store.saltValue);
  store.add(mappings);

  acc.detected += result.findings.length;
  for (const f of result.findings) acc.types.push(f.type);
  for (const m of mappings) {
    acc.mocks.add(m.mock);
    // Leak guard, scoped to THIS rewritten string: the real value must
    // not survive the swap. Checked and discarded immediately.
    if (m.real.length > 0 && swappedText.includes(m.real)) acc.leaked = true;
  }
  return swappedText;
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
export async function runDetectorSwap(
  adapter: ProviderAdapter,
  raw: Buffer,
  config: GatewayConfig,
  store: SessionStore,
): Promise<SwapOutcome> {
  const passthrough = (): SwapOutcome => ({
    body: raw,
    processed: false,
    detected: 0,
    swapCount: 0,
    injected: false,
    types: [],
    mockCount: 0,
    leaked: false,
  });

  if (raw.length === 0) return passthrough();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return passthrough();
  }
  if (parsed === null || typeof parsed !== "object") return passthrough();

  const acc: Acc = { detected: 0, types: [], mocks: new Set(), leaked: false };
  await adapter.forEachText(parsed, (text) => swapText(text, config, store, acc));

  if (acc.detected === 0) {
    // Nothing matched — forward the original bytes untouched. No injection
    // when there are no mocks to preserve.
    return { ...passthrough(), processed: true };
  }

  // Count mocks on the swapped body BEFORE injecting the directive, so the
  // directive's illustrative example token doesn't inflate the metric.
  const mockCount = (JSON.stringify(parsed).match(/WYLOC_MOCK_/g) ?? []).length;

  // System-prompt injection (config toggle, default on). Only when we
  // actually swapped something this request — i.e. mocks are present.
  let injected = false;
  if (config.injectSystemPrompt) {
    adapter.injectDirective(parsed);
    injected = true;
  }

  return {
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    processed: true,
    detected: acc.detected,
    swapCount: acc.mocks.size,
    injected,
    types: acc.types,
    mockCount,
    leaked: acc.leaked,
  };
}
