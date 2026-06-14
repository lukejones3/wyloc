/**
 * Anthropic Messages-format adapter.
 *
 * This is a behavior-preserving relocation of the original request walk +
 * directive injection (from swap-request.ts) and the existing SSE rehydrator
 * (sse-rehydrate.ts) behind the ProviderAdapter seam. The Claude Code path
 * behaves identically to before.
 */
import type { MockMapping } from "../session.js";
import { WYLOC_DIRECTIVE } from "../directive.js";
import { rehydrateSse } from "../sse-rehydrate.js";
import { isTextPart, type ProviderAdapter, type TextVisitor } from "./types.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  constructor(readonly defaultUpstreamBaseUrl: string) {}

  /**
   * Rewrite: top-level `system` (string or text-block array) + every `text`
   * block inside `messages[]` (any role; bare-string content too). tool_use /
   * tool_result / image / document blocks are left exactly as received.
   */
  async forEachText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { system?: unknown; messages?: unknown };

    if (typeof obj.system === "string") {
      obj.system = await visit(obj.system);
    } else if (Array.isArray(obj.system)) {
      for (const block of obj.system) {
        if (isTextPart(block)) block.text = await visit(block.text);
      }
    }

    if (Array.isArray(obj.messages)) {
      for (const msg of obj.messages) {
        if (msg === null || typeof msg !== "object") continue;
        const content = (msg as { content?: unknown }).content;
        if (typeof content === "string") {
          (msg as { content: unknown }).content = await visit(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (isTextPart(block)) block.text = await visit(block.text);
          }
        }
      }
    }
  }

  /**
   * Rewrite the TEXT payload of every `tool_result` block (the file content an
   * agentic client read) — `content` as a bare string, or the `text` of each
   * `{type:"text"}` sub-block. The `type` / `tool_use_id` envelope and any
   * image/document sub-blocks are left exactly as received.
   */
  async forEachToolResultText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { messages?: unknown };
    if (!Array.isArray(obj.messages)) return;
    for (const msg of obj.messages) {
      if (msg === null || typeof msg !== "object") continue;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue; // tool_result only ever appears in a block array
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        if ((block as { type?: unknown }).type !== "tool_result") continue;
        const tr = block as { content?: unknown };
        if (typeof tr.content === "string") {
          tr.content = await visit(tr.content);
        } else if (Array.isArray(tr.content)) {
          for (const sub of tr.content) {
            if (isTextPart(sub)) sub.text = await visit(sub.text);
          }
        }
      }
    }
  }

  injectDirective(body: unknown): void {
    const obj = body as { system?: unknown };
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

  rehydrateResponse(
    source: AsyncIterable<Uint8Array>,
    mappings: readonly MockMapping[],
  ): AsyncIterable<Uint8Array> {
    return rehydrateSse(source, mappings);
  }
}
