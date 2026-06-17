/**
 * Provider-adapter seam.
 *
 * The masking/detector/SQL/rehydration core is wire-format-agnostic. The only
 * format-specific things are (1) *which* strings in a request body are maskable
 * (and how to write them back) + where the directive goes, and (2) how to
 * pull/replace the assistant's visible text out of a streamed response chunk.
 * A ProviderAdapter encapsulates exactly those; both Anthropic and OpenAI
 * adapters call into the same shared core.
 */
import type { MockMapping } from "../session.js";

/** A text transform applied to one maskable string. May be sync or async. */
export type TextVisitor = (text: string) => string | Promise<string>;

export interface ProviderAdapter {
  readonly id: "anthropic" | "openai" | "gemini";
  /** Upstream origin this adapter forwards to (overridable via config). */
  readonly defaultUpstreamBaseUrl: string;

  /**
   * Walk the parsed request body and replace every maskable text string in
   * place using `visit`. Rewrites user/system (and assistant) message text in
   * both string and array-of-parts forms; never touches tool-call structure.
   */
  forEachText(body: unknown, visit: TextVisitor): Promise<void>;

  /**
   * Walk the parsed request body and replace the TEXT content of tool results
   * (the files an agentic client read) in place using `visit`. This is the
   * payload only — the tool-call ENVELOPE (tool_use_id / tool_call_id / role /
   * type / name / arguments) and any non-text blocks (images, documents) are
   * never touched. Anthropic: `tool_result` block content; OpenAI: `role:"tool"`
   * message content.
   */
  forEachToolResultText(body: unknown, visit: TextVisitor): Promise<void>;

  /** Inject the verbatim-echo directive into the request (provider-specific). */
  injectDirective(body: unknown): void;

  /** Rehydrate a streamed response in this provider's SSE shape. */
  rehydrateResponse(
    source: AsyncIterable<Uint8Array>,
    mappings: readonly MockMapping[],
  ): AsyncIterable<Uint8Array>;
}

/** A `{type:"text", text}` content part — identical in Anthropic and OpenAI Chat. */
export function isTextPart(b: unknown): b is { type: "text"; text: string } {
  return (
    b !== null &&
    typeof b === "object" &&
    (b as { type?: unknown }).type === "text" &&
    typeof (b as { text?: unknown }).text === "string"
  );
}
