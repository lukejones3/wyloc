/**
 * Request-path real→mock swap.
 *
 * Parses an Anthropic Messages-format request body and replaces detected
 * secrets in USER TEXT ONLY with WYLOC_MOCK_ placeholders, using the
 * shared @wyloc/detector engine (`scan` + `buildSwap`). Detection is NOT
 * reimplemented here — this module only decides *which strings* to feed
 * the engine and how to stitch the result back into the JSON.
 *
 * WHAT WE REWRITE:
 *   • `system` — both the string form and the array-of-text-blocks form.
 *   • every `text` content block's `.text` inside `messages[]`.
 *   • a message whose `content` is a bare string (shorthand text).
 *
 * WHAT WE NEVER TOUCH (must pass through byte-intact or tool calling
 * breaks — confirmed in Phase 1):
 *   • `tool_use` blocks (id / name / input)
 *   • `tool_result` blocks (tool_use_id / content)
 *   • `image` / `document` blocks
 *   • any structural field, ordering, or non-text key
 *
 * Determinism: the session salt makes the same secret always map to the
 * same mock, so re-sending conversation history (which on later turns may
 * carry a real value Phase 3 rehydrated) re-swaps to the identical mock —
 * the mapping stays consistent across turns with no special-casing.
 */

import { scan, buildSwap, type SecretType } from "@wyloc/detector";
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

/** Rewrite the top-level `system` field (string or text-block array). */
function processSystem(system: unknown, config: GatewayConfig, store: SessionStore, acc: Acc): unknown {
  if (typeof system === "string") {
    return swapText(system, config, store, acc);
  }
  if (Array.isArray(system)) {
    for (const block of system) {
      if (isTextBlock(block)) block.text = swapText(block.text, config, store, acc);
    }
  }
  return system;
}

/** Rewrite text content within the messages array. */
function processMessages(messages: unknown, config: GatewayConfig, store: SessionStore, acc: Acc): void {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;

    if (typeof content === "string") {
      // Shorthand: a bare string is a single text block.
      (msg as { content: unknown }).content = swapText(content, config, store, acc);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        // ONLY text blocks. tool_use / tool_result / image / document are
        // left exactly as received.
        if (isTextBlock(block)) block.text = swapText(block.text, config, store, acc);
      }
    }
  }
}

/**
 * Directive appended to the system prompt when injection is enabled. It
 * tells the model to reproduce WYLOC_MOCK_ tokens verbatim so they match
 * exactly for streaming rehydration. Appended (not prepended) so any
 * cached system prefix the client sent stays byte-stable for prompt cache.
 */
const WYLOC_DIRECTIVE =
  "[Wyloc secret-protection notice]\n" +
  "Some sensitive values in this conversation have been replaced with placeholder " +
  "tokens of the form WYLOC_MOCK_<TYPE>_<ID> (for example, WYLOC" +
  "_MOCK_EXAMPLE_TOKEN_000000). They are intentional stand-ins for real " +
  "credentials. Whenever you reference or reproduce such a value, output the " +
  "placeholder token EXACTLY as written — exact case, exact characters, no " +
  "truncation, no inserted spaces or line breaks, no reformatting. Never invent " +
  "new WYLOC_MOCK_ tokens. Treat each placeholder as an opaque literal.";

/**
 * Append the verbatim-echo directive to the request's `system` field,
 * handling the absent / string / text-block-array forms.
 */
function injectDirective(obj: { system?: unknown }): void {
  const sys = obj.system;
  if (sys === undefined || sys === null) {
    obj.system = WYLOC_DIRECTIVE;
  } else if (typeof sys === "string") {
    obj.system = `${sys}\n\n${WYLOC_DIRECTIVE}`;
  } else if (Array.isArray(sys)) {
    sys.push({ type: "text", text: WYLOC_DIRECTIVE });
  }
  // Any other shape: leave untouched rather than risk corrupting it.
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Swap secrets out of a Messages-format request body.
 *
 * If the body is not parseable JSON it is returned untouched
 * (`processed: false`) — we never risk corrupting a request we don't
 * understand. The detector config and session store come from the
 * gateway config seam; nothing here is hardcoded.
 */
export function swapRequest(
  raw: Buffer,
  config: GatewayConfig,
  store: SessionStore,
): SwapOutcome {
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
  const obj = parsed as { system?: unknown; messages?: unknown };

  if ("system" in obj) obj.system = processSystem(obj.system, config, store, acc);
  processMessages(obj.messages, config, store, acc);

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
    injectDirective(obj);
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
