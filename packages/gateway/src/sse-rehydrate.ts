/**
 * SSE-aware response rewriter.
 *
 * Wraps the upstream Anthropic SSE byte stream and yields a rewritten SSE
 * byte stream in which `WYLOC_MOCK_` placeholders inside the assistant's
 * visible text are rehydrated back to their real values — while every
 * other byte of the protocol is preserved:
 *
 *   • ONLY `content_block_delta` events whose `delta.type === "text_delta"`
 *     are touched. Their text is run through `RehydrationStream` (token-
 *     boundary buffered) and re-emitted as a `text_delta`.
 *   • `input_json_delta`, `thinking_delta`, `signature_delta`,
 *     `message_start/_delta/_stop`, `content_block_start/_stop`, `ping`,
 *     and anything else are forwarded BYTE-IDENTICAL.
 *   • Held-back partial text for a block is flushed before that block's
 *     `content_block_stop` (and at stream end), so the stream stays valid.
 *
 * The transform is incremental: it parses whole SSE events as they arrive
 * (events are separated by a blank line) and emits as it goes. It never
 * buffers the whole response — at most a partial mock token is held.
 */

import type { SwapMapping } from "@wyloc/detector";
import { RehydrationStream } from "./rehydrate-stream.js";

/** Pull the concatenated `data:` payload out of one raw SSE event. */
function extractData(rawEvent: string): string | null {
  let data: string | null = null;
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === null ? value : data + "\n" + value;
    }
  }
  return data;
}

/** Serialize a synthetic text_delta event carrying rehydrated text. */
function makeTextDelta(index: number, text: string): string {
  const payload = JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
  return `event: content_block_delta\ndata: ${payload}\n\n`;
}

/**
 * Rehydrate an Anthropic SSE stream. `mappings` is a snapshot of the
 * session store taken when the response begins.
 */
export async function* rehydrateSse(
  source: AsyncIterable<Uint8Array>,
  mappings: readonly SwapMapping[],
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new RehydrationStream(mappings);
  let buf = "";
  let currentIndex = 0;

  /** Handle one complete raw SSE event; returns the SSE text to emit. */
  const handleEvent = (rawEvent: string): string => {
    if (rawEvent.length === 0) return "";

    const data = extractData(rawEvent);
    let parsed: { type?: string; index?: number; delta?: { type?: string; text?: string } } | null =
      null;
    if (data !== null) {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = null;
      }
    }
    const type = parsed?.type;

    // A text_delta: replace with a rehydrated synthetic delta. If the push
    // produced no flushable text (all held), emit nothing — the held text
    // rides along to a later delta or the block's stop.
    if (
      type === "content_block_delta" &&
      parsed?.delta?.type === "text_delta"
    ) {
      if (typeof parsed.index === "number") currentIndex = parsed.index;
      const emit = stream.pushText(String(parsed.delta.text ?? ""));
      return emit.length > 0 ? makeTextDelta(currentIndex, emit) : "";
    }

    // Block boundaries: flush any held text for the current block BEFORE
    // the structural event so ordering/framing stay valid.
    if (type === "content_block_start") {
      const tail = stream.flush();
      const prefix = tail.length > 0 ? makeTextDelta(currentIndex, tail) : "";
      stream.resetBlock();
      if (typeof parsed?.index === "number") currentIndex = parsed.index;
      return prefix + rawEvent + "\n\n";
    }
    if (type === "content_block_stop") {
      if (typeof parsed?.index === "number") currentIndex = parsed.index;
      const tail = stream.flush();
      const prefix = tail.length > 0 ? makeTextDelta(currentIndex, tail) : "";
      stream.resetBlock();
      return prefix + rawEvent + "\n\n";
    }

    // Everything else: byte-identical pass-through.
    return rawEvent + "\n\n";
  };

  for await (const chunk of source) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const out = handleEvent(rawEvent);
      if (out.length > 0) yield encoder.encode(out);
    }
  }

  // Drain any trailing bytes the decoder was holding, then any final event
  // and any text still buffered (defensive — a well-formed stream will
  // already have flushed at content_block_stop).
  buf += decoder.decode();
  if (buf.length > 0) {
    const out = handleEvent(buf);
    if (out.length > 0) yield encoder.encode(out);
  }
  const tail = stream.flush();
  if (tail.length > 0) yield encoder.encode(makeTextDelta(currentIndex, tail));
}
