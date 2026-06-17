/**
 * Rehydration for the OpenAI Responses API SSE stream.
 *
 * Two text surfaces must be reversed (mock → real), unlike Chat Completions:
 *
 *  1. INCREMENTAL deltas — `response.output_text.delta` (+ refusal /
 *     reasoning-summary deltas) carry `delta` text chunks. Run each through a
 *     per-stream `RehydrationStream` (token-boundary buffered) so a mock split
 *     across deltas is reversed intact and LLM-invented identifiers pass through.
 *
 *  2. TERMINAL full text — `response.output_text.done` / `.refusal.done` /
 *     `.reasoning_summary_text.done` re-emit the COMPLETE text, and
 *     `response.completed` carries the whole response object (output[].content[]
 *     text). Chat has no equivalent; if we only fixed the deltas the final
 *     aggregated payload would leak the mock. These are whole strings, so we
 *     reverse them in one shot. At each `*.done` we also flush the matching
 *     delta stream's held tail as a synthetic delta so incremental readers get
 *     the complete rehydrated text too.
 *
 * Everything else — function-call argument deltas, code deltas, lifecycle
 * events, framing — passes through byte-for-byte.
 */
import type { MockMapping } from "./session.js";
import { RehydrationStream } from "./rehydrate-stream.js";

const TEXT_DELTA = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_summary_text.delta",
]);
const TEXT_DONE = new Set([
  "response.output_text.done",
  "response.refusal.done",
  "response.reasoning_summary_text.done",
]);

/** Reverse mocks in a COMPLETE string (no buffering needed). */
function whole(text: string, mappings: readonly MockMapping[]): string {
  const s = new RehydrationStream(mappings);
  return s.pushText(text) + s.flush();
}

/** Pull the concatenated `data:` payload out of one raw SSE event. */
function extractData(lines: string[]): string | null {
  let data: string | null = null;
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const v = line.slice(5).replace(/^ /, "");
      data = data === null ? v : `${data}\n${v}`;
    }
  }
  return data;
}

/** Rebuild an event: keep its non-data lines (e.g. `event:`), swap the data JSON. */
function rebuild(lines: string[], obj: unknown): string {
  const kept = lines.filter((l) => !l.startsWith("data:"));
  kept.push(`data: ${JSON.stringify(obj)}`);
  return kept.join("\n") + "\n\n";
}

export async function* rehydrateResponsesStream(
  source: AsyncIterable<Uint8Array>,
  mappings: readonly MockMapping[],
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streams = new Map<string, RehydrationStream>();
  const streamFor = (key: string): RehydrationStream => {
    let s = streams.get(key);
    if (!s) { s = new RehydrationStream(mappings); streams.set(key, s); }
    return s;
  };
  const keyOf = (o: Record<string, unknown>): string =>
    `${o.item_id ?? "?"}:${o.content_index ?? o.summary_index ?? o.output_index ?? 0}`;

  let buf = "";

  const handle = (rawEvent: string): string => {
    if (rawEvent.length === 0) return "";
    const lines = rawEvent.split("\n");
    const data = extractData(lines);
    if (data === null) return `${rawEvent}\n\n`;        // comment / non-data
    if (data.trim() === "[DONE]") return `${rawEvent}\n\n`;

    let obj: Record<string, unknown>;
    try { obj = JSON.parse(data) as Record<string, unknown>; } catch { return `${rawEvent}\n\n`; }
    const type = typeof obj.type === "string" ? obj.type : undefined;

    // 1. Incremental text deltas → buffered per-stream rehydration.
    if (type && TEXT_DELTA.has(type) && typeof obj.delta === "string") {
      obj.delta = streamFor(keyOf(obj)).pushText(obj.delta);
      return rebuild(lines, obj);
    }

    // 2. Terminal per-field full text → flush the stream + whole-string reverse.
    if (type && TEXT_DONE.has(type)) {
      let prefix = "";
      const tail = streamFor(keyOf(obj)).flush();
      if (tail.length > 0) {
        // emit the held tail as a synthetic delta so incremental readers are complete
        const deltaType = type.replace(/\.done$/, ".delta");
        prefix = rebuild(["event: " + deltaType], { ...obj, type: deltaType, delta: tail });
      }
      if (typeof obj.text === "string") obj.text = whole(obj.text, mappings);
      if (typeof obj.refusal === "string") obj.refusal = whole(obj.refusal, mappings);
      return prefix + rebuild(lines, obj);
    }

    // 3. Terminal aggregated response object → reverse every text field in it.
    if (type === "response.completed" || type === "response.incomplete") {
      rehydrateResponseObject(obj.response, mappings);
      return rebuild(lines, obj);
    }

    // Everything else (function-call args, code deltas, lifecycle) is structure.
    return `${rawEvent}\n\n`;
  };

  for await (const part of source) {
    buf += decoder.decode(part, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const ev = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const out = handle(ev);
      if (out.length > 0) yield encoder.encode(out);
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) {
    const out = handle(buf);
    if (out.length > 0) yield encoder.encode(out);
  }
}

/** Reverse mocks in the nested text fields of a completed `response` object. */
function rehydrateResponseObject(response: unknown, mappings: readonly MockMapping[]): void {
  if (response === null || typeof response !== "object") return;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return;
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (typeof p.text === "string") p.text = whole(p.text, mappings);
      if (typeof p.refusal === "string") p.refusal = whole(p.refusal, mappings);
    }
  }
}
