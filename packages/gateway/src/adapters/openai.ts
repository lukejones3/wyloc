/**
 * OpenAI Chat Completions (/v1/chat/completions) adapter.
 *
 * Mirrors the Anthropic adapter, for the OpenAI wire format:
 *   • request: rewrite text in system/developer/user/assistant messages
 *     (string or {type:"text",text} parts); skip role:"tool" and never touch
 *     tool_calls — the parity to leaving tool_result/tool_use intact.
 *   • directive: append to the first system/developer message (insert one if
 *     absent), only when a secret was swapped (handled by the caller).
 *   • response: rehydrate choices[].delta.content via the SAME token-boundary
 *     RehydrationStream that the Anthropic path uses (reverses WYLOC_MOCK_ AND
 *     semantic SQL masks), one stream per choice index, flushed at
 *     finish_reason / [DONE]. All other framing passes through.
 */
import type { MockMapping } from "../session.js";
import { WYLOC_DIRECTIVE } from "../directive.js";
import { RehydrationStream } from "../rehydrate-stream.js";
import { isTextPart, type ProviderAdapter, type TextVisitor } from "./types.js";

interface OpenAiMessage {
  role?: unknown;
  content?: unknown;
}

/** Pull the concatenated `data:` payload out of one raw SSE event. */
function extractData(rawEvent: string): string | null {
  let data: string | null = null;
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === null ? value : `${data}\n${value}`;
    }
  }
  return data;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  constructor(readonly defaultUpstreamBaseUrl: string) {}

  async forEachText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { messages?: unknown };
    if (!Array.isArray(obj.messages)) return;
    for (const msg of obj.messages) {
      if (msg === null || typeof msg !== "object") continue;
      const m = msg as OpenAiMessage;
      if (m.role === "tool") continue; // tool output — leave intact (parity with tool_result)
      if (typeof m.content === "string") {
        m.content = await visit(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (isTextPart(part)) part.text = await visit(part.text);
        }
      }
      // tool_calls (and their function.arguments) are never touched.
    }
  }

  /**
   * Rewrite the TEXT content of every `role:"tool"` message (the file content
   * an agentic client read). Handles string content and `{type:"text"}` parts.
   * `role` / `tool_call_id` and any assistant `tool_calls` are never touched.
   */
  async forEachToolResultText(body: unknown, visit: TextVisitor): Promise<void> {
    const obj = body as { messages?: unknown };
    if (!Array.isArray(obj.messages)) return;
    for (const msg of obj.messages) {
      if (msg === null || typeof msg !== "object") continue;
      const m = msg as OpenAiMessage;
      if (m.role !== "tool") continue;
      if (typeof m.content === "string") {
        m.content = await visit(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (isTextPart(part)) part.text = await visit(part.text);
        }
      }
    }
  }

  injectDirective(body: unknown): void {
    const obj = body as { messages?: unknown };
    if (!Array.isArray(obj.messages)) return;
    const sys = obj.messages.find(
      (m): m is OpenAiMessage =>
        m !== null && typeof m === "object" &&
        ((m as OpenAiMessage).role === "system" || (m as OpenAiMessage).role === "developer"),
    );
    if (sys) {
      if (typeof sys.content === "string") {
        sys.content = `${sys.content}\n\n${WYLOC_DIRECTIVE}`;
      } else if (Array.isArray(sys.content)) {
        sys.content.push({ type: "text", text: WYLOC_DIRECTIVE });
      } else {
        sys.content = WYLOC_DIRECTIVE;
      }
    } else {
      obj.messages.unshift({ role: "system", content: WYLOC_DIRECTIVE });
    }
  }

  rehydrateResponse(
    source: AsyncIterable<Uint8Array>,
    mappings: readonly MockMapping[],
  ): AsyncIterable<Uint8Array> {
    return rehydrateChatCompletions(source, mappings);
  }
}

interface Chunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { content?: unknown };
    finish_reason?: unknown;
  }>;
}

/**
 * Rehydrate an OpenAI Chat Completions SSE stream. Each `data:` line is a
 * `chat.completion.chunk`; we run each choice's `delta.content` through a
 * per-index RehydrationStream (token-boundary buffered) and flush the tail at
 * that choice's `finish_reason`. The `data: [DONE]` sentinel and everything
 * else (tool-call deltas, comments, framing) pass through untouched.
 */
async function* rehydrateChatCompletions(
  source: AsyncIterable<Uint8Array>,
  mappings: readonly MockMapping[],
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streams = new Map<number, RehydrationStream>();
  const streamFor = (i: number): RehydrationStream => {
    let s = streams.get(i);
    if (!s) {
      s = new RehydrationStream(mappings);
      streams.set(i, s);
    }
    return s;
  };
  let buf = "";

  const handleEvent = (rawEvent: string): string => {
    if (rawEvent.length === 0) return "";
    const data = extractData(rawEvent);
    if (data === null) return `${rawEvent}\n\n`; // comment / non-data line

    if (data.trim() === "[DONE]") {
      // Defensive flush (finish_reason normally drained already).
      let prefix = "";
      for (const [, s] of streams) {
        const tail = s.flush();
        if (tail.length > 0) {
          prefix += `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] })}\n\n`;
        }
      }
      return prefix + `${rawEvent}\n\n`;
    }

    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      return `${rawEvent}\n\n`;
    }
    if (chunk.object !== "chat.completion.chunk" || !Array.isArray(chunk.choices)) {
      return `${rawEvent}\n\n`;
    }

    for (const choice of chunk.choices) {
      const idx = typeof choice.index === "number" ? choice.index : 0;
      const s = streamFor(idx);
      const delta = choice.delta;
      const hadContent = delta != null && typeof delta.content === "string";
      let text = hadContent ? s.pushText(String(delta!.content)) : "";
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        text += s.flush();
      }
      if (delta != null && (hadContent || text.length > 0)) {
        delta.content = text;
      }
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  for await (const part of source) {
    buf += decoder.decode(part, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const out = handleEvent(rawEvent);
      if (out.length > 0) yield encoder.encode(out);
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) {
    const out = handleEvent(buf);
    if (out.length > 0) yield encoder.encode(out);
  }
}
