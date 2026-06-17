/**
 * Rehydration for the Google Gemini `streamGenerateContent?alt=sse` stream.
 *
 * Unlike the OpenAI Responses stream, Gemini streams PURE INCREMENTAL deltas:
 * each SSE event is a partial `GenerateContentResponse` whose
 * `candidates[].content.parts[].text` carries only the NEW text for that chunk
 * (verified against the API reference — there is no terminal full-text
 * re-emission, no `*.done` event, no aggregated final object that repeats the
 * whole message). So the only surface to reverse (mock → real) is those
 * incremental text parts, run through a per-candidate `RehydrationStream`
 * (token-boundary buffered) so a mock split across chunks is reversed intact and
 * model-invented identifiers pass through.
 *
 * A part may instead carry `functionCall` (a tool call) — those have no `.text`
 * and pass through byte-for-byte, along with `usageMetadata`, framing, and every
 * other field. We flush each candidate's held tail when its `finishReason` is
 * set (appending to that chunk's last text part, or emitting a small text part
 * if the terminal chunk had none).
 */
import type { MockMapping } from "./session.js";
import { RehydrationStream } from "./rehydrate-stream.js";

interface Part { text?: unknown; functionCall?: unknown }
interface Candidate {
  index?: number;
  content?: { role?: unknown; parts?: unknown };
  finishReason?: unknown;
}
interface GeminiChunk { candidates?: unknown }

/** Pull the concatenated `data:` payload out of one raw SSE event. */
function extractData(rawEvent: string): string | null {
  let data: string | null = null;
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === null ? value : `${data}\n${value}`;
    }
  }
  return data;
}

export async function* rehydrateGeminiStream(
  source: AsyncIterable<Uint8Array>,
  mappings: readonly MockMapping[],
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streams = new Map<number, RehydrationStream>();
  const streamFor = (i: number): RehydrationStream => {
    let s = streams.get(i);
    if (!s) { s = new RehydrationStream(mappings); streams.set(i, s); }
    return s;
  };
  let buf = "";

  const handleEvent = (rawEvent: string): string => {
    if (rawEvent.length === 0) return "";
    const data = extractData(rawEvent);
    if (data === null) return `${rawEvent}\n\n`;          // comment / non-data
    if (data.trim() === "[DONE]") return `${rawEvent}\n\n`; // not Gemini's, but harmless

    let chunk: GeminiChunk;
    try { chunk = JSON.parse(data) as GeminiChunk; } catch { return `${rawEvent}\n\n`; }
    if (!Array.isArray(chunk.candidates)) return `${rawEvent}\n\n`;

    for (const cand of chunk.candidates as Candidate[]) {
      if (cand === null || typeof cand !== "object") continue;
      const idx = typeof cand.index === "number" ? cand.index : 0;
      const s = streamFor(idx);
      const parts = cand.content && Array.isArray((cand.content as { parts?: unknown }).parts)
        ? ((cand.content as { parts: Part[] }).parts)
        : null;

      let lastTextPart: Part | null = null;
      if (parts) {
        for (const part of parts) {
          if (part !== null && typeof part === "object" && typeof part.text === "string") {
            part.text = s.pushText(part.text);
            lastTextPart = part;
          }
          // functionCall / inlineData / other parts: structure — passed through.
        }
      }

      // Drain the held tail at end-of-candidate so the final text is complete.
      if (cand.finishReason !== null && cand.finishReason !== undefined) {
        const tail = s.flush();
        if (tail.length > 0) {
          if (lastTextPart) {
            lastTextPart.text = String(lastTextPart.text) + tail;
          } else {
            // Terminal chunk carried no text part — synthesize one so the held
            // suffix (a completed mock's tail) is not dropped.
            const content = (cand.content && typeof cand.content === "object")
              ? (cand.content as { role?: unknown; parts?: unknown })
              : (cand.content = { parts: [] } as { role?: unknown; parts?: unknown });
            if (!Array.isArray(content.parts)) content.parts = [];
            (content.parts as Part[]).push({ text: tail });
          }
        }
      }
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  for await (const part of source) {
    buf += decoder.decode(part, { stream: true });
    let m: RegExpExecArray | null;
    // Event boundary is a blank line; Gemini uses \r\n, tolerate either.
    while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
      const rawEvent = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
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
