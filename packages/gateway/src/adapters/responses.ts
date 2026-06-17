/**
 * OpenAI Responses API (/v1/responses) adapter — the wire format Codex uses.
 *
 * Structurally different from Chat Completions (see Phase-1 mapping):
 *   • system prompt   → top-level `instructions` string (not a system message)
 *   • user/history    → `input`: a string, OR an array of items
 *   • message content → parts `{type:"input_text"|"output_text", text}`
 *                       (NOT Chat's {type:"text"} — needs its own predicate)
 *   • tool results    → `function_call_output` ITEMS inside `input[]`
 *                       (the file-read equivalent of Chat's role:"tool")
 *   • tool calls      → `function_call` items (left byte-intact, like tool_calls)
 *
 * Like the other adapters this carries NO masking logic — it only tells the
 * shared engine WHICH strings are maskable and where the directive goes, so the
 * detector / sql-masker / code-masker / file-read passes all apply unchanged.
 * `forEachToolResultText` feeds the SAME file-read content-router as Chat's
 * role:"tool" and Anthropic's tool_result (detector always, SQL/code on sniff).
 */
import type { MockMapping } from "../session.js";
import { WYLOC_DIRECTIVE } from "../directive.js";
import { rehydrateResponsesStream } from "../sse-rehydrate-responses.js";
import type { ProviderAdapter, TextVisitor } from "./types.js";

/** A Responses content part that carries maskable prose. */
function isResponsesTextPart(b: unknown): b is { text: string } {
  if (b === null || typeof b !== "object") return false;
  const t = (b as { type?: unknown }).type;
  return (t === "input_text" || t === "output_text") && typeof (b as { text?: unknown }).text === "string";
}

/** True for an input array item that is a chat message (explicit or shorthand). */
function isMessageItem(it: { type?: unknown; role?: unknown }): boolean {
  return it.type === "message" || (it.type === undefined && typeof it.role === "string");
}

async function maskContentField(
  container: { content?: unknown },
  visit: TextVisitor,
): Promise<void> {
  if (typeof container.content === "string") {
    container.content = await visit(container.content);
  } else if (Array.isArray(container.content)) {
    for (const part of container.content) {
      if (isResponsesTextPart(part)) part.text = await visit(part.text);
    }
  }
}

export class ResponsesAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  constructor(readonly defaultUpstreamBaseUrl: string) {}

  /**
   * Rewrite every prose-bearing field: top-level `instructions`, and `input`
   * (a bare string, or message items' string/`input_text`/`output_text`
   * content). function_call / function_call_output / reasoning items are NOT
   * touched here (args + tool envelope stay intact; tool-result CONTENT is
   * handled by forEachToolResultText so it flows through the file-read router).
   */
  async forEachText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { instructions?: unknown; input?: unknown };

    if (typeof obj.instructions === "string") {
      obj.instructions = await visit(obj.instructions);
    }

    if (typeof obj.input === "string") {
      obj.input = await visit(obj.input);
      return;
    }
    if (!Array.isArray(obj.input)) return;
    for (const item of obj.input) {
      if (item === null || typeof item !== "object") continue;
      const it = item as { type?: unknown; role?: unknown; content?: unknown };
      if (isMessageItem(it)) await maskContentField(it, visit);
      // function_call (arguments), function_call_output, reasoning: left as-is.
    }
  }

  /**
   * Rewrite the CONTENT of every `function_call_output` item — the result a
   * tool/file-read returned (where Codex's read file content lands). `output`
   * is a string or an array of output-content parts. `call_id`/`type` (the
   * envelope) are never touched. Routed through the same content-router as
   * Chat's role:"tool" / Anthropic's tool_result.
   */
  async forEachToolResultText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { input?: unknown };
    if (!Array.isArray(obj.input)) return;
    for (const item of obj.input) {
      if (item === null || typeof item !== "object") continue;
      const it = item as { type?: unknown; output?: unknown };
      if (it.type !== "function_call_output") continue;
      if (typeof it.output === "string") {
        it.output = await visit(it.output);
      } else if (Array.isArray(it.output)) {
        for (const part of it.output) {
          // Output content parts vary; mask any part carrying a string `text`.
          if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            (part as { text: string }).text = await visit((part as { text: string }).text);
          }
        }
      }
    }
  }

  /** The verbatim-echo directive goes into `instructions` (Responses has no
   *  system message). Append if present, create if absent; never corrupt a
   *  non-string instructions value. */
  injectDirective(body: unknown): void {
    const obj = body as { instructions?: unknown };
    if (typeof obj.instructions === "string") {
      obj.instructions = `${obj.instructions}\n\n${WYLOC_DIRECTIVE}`;
    } else if (obj.instructions === undefined || obj.instructions === null) {
      obj.instructions = WYLOC_DIRECTIVE;
    }
  }

  rehydrateResponse(
    source: AsyncIterable<Uint8Array>,
    mappings: readonly MockMapping[],
  ): AsyncIterable<Uint8Array> {
    return rehydrateResponsesStream(source, mappings);
  }
}
