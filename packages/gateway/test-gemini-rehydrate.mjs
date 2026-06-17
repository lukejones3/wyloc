/**
 * Gemini streamGenerateContent rehydration unit tests.
 * Run with: node --import tsx test-gemini-rehydrate.mjs
 *
 * Feeds a synthetic Gemini SSE stream (mock embedded, split across incremental
 * deltas, \r\n framed) through rehydrateGeminiStream and asserts: split mock
 * reassembles across chunks, the held tail flushes at finishReason, functionCall
 * parts pass through untouched, multiple candidates rehydrate independently, and
 * clean text is a no-op. Gemini has NO terminal full-text re-emission, so the
 * concatenated deltas ARE the complete message — that's what we verify.
 */
import { rehydrateGeminiStream } from "./src/sse-rehydrate-gemini.ts";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

const REAL = "AKIA5XQ2WJ8NPLR3MKVT";
const MOCK = "WYLOC_MOCK_AWS_ACCESS_KEY_ABC123";
const mappings = [{ real: REAL, mock: MOCK }];

// Gemini frames events with CRLF blank lines — exercise that here.
function ev(obj) { return `data: ${JSON.stringify(obj)}\r\n\r\n`; }
function cand(parts, finishReason = null, index = 0) {
  return { candidates: [{ content: { role: "model", parts }, finishReason, index }] };
}

async function run(events) {
  const enc = new TextEncoder();
  async function* src() { for (const e of events) yield enc.encode(e); }
  let out = "";
  for await (const c of rehydrateGeminiStream(src(), mappings)) out += new TextDecoder().decode(c);
  return out;
}
function parse(out) {
  return out.split(/\r?\n\r?\n/).filter((b) => b.trim()).map((blk) => {
    const data = blk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    try { return JSON.parse(data); } catch { return { raw: blk }; }
  });
}
const textOf = (parsed) =>
  parsed.flatMap((e) => (e.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "")).join("");
// Concatenate the streamed text for ONE candidate index across all chunks (a
// held mock flushes in a later chunk than where it started — that's correct).
const textForIndex = (parsed, idx) =>
  parsed.flatMap((e) => (e.candidates ?? [])
    .filter((c) => (c.index ?? 0) === idx)
    .flatMap((c) => (c.content?.parts ?? []).map((p) => p.text ?? ""))).join("");

async function main() {
  // ── 1. Split mock across incremental deltas, tail flushed at finishReason ──
  {
    const full = `The key is ${REAL} now.`;
    const events = [
      ev(cand([{ text: "The key is WYLOC_MOCK_AWS" }])),
      ev(cand([{ text: "_ACCESS_KEY_" }])),
      ev(cand([{ text: "ABC123 now." }])),
      ev(cand([{ text: "" }], "STOP")),
    ];
    const out = await run(events);
    ok("split mock across deltas rehydrates intact", textOf(parse(out)) === full, JSON.stringify(textOf(parse(out))));
    ok("no mock token anywhere in output", !out.includes("WYLOC_MOCK_"));
  }

  // ── 2. Mock whose tail is still held at the terminal chunk gets flushed ──
  {
    // The whole mock arrives split with the suffix only completing right before
    // STOP; the final chunk carries no text → the held tail must be synthesized.
    const events = [
      ev(cand([{ text: `key=${MOCK.slice(0, 20)}` }])),
      ev(cand([{ text: MOCK.slice(20) }], "STOP")),
    ];
    const out = await run(events);
    ok("held tail flushed at finishReason (no drop)", textOf(parse(out)) === `key=${REAL}`, JSON.stringify(textOf(parse(out))));
    ok("terminal flush leaves no mock", !out.includes("WYLOC_MOCK_"));
  }

  // ── 3. functionCall parts pass through untouched ──
  {
    const fc = { functionCall: { name: "read_file", args: { token: MOCK } } };
    const out = await run([ev(cand([fc], "STOP"))]);
    const p = parse(out)[0]?.candidates?.[0]?.content?.parts?.[0];
    ok("functionCall passes through (args byte-intact)",
      p?.functionCall?.name === "read_file" && p?.functionCall?.args?.token === MOCK, JSON.stringify(p));
  }

  // ── 4. Multiple candidates rehydrate independently ──
  {
    const events = [
      ev({ candidates: [
        { content: { role: "model", parts: [{ text: `a:${MOCK}` }] }, finishReason: null, index: 0 },
        { content: { role: "model", parts: [{ text: "b: clean" }] }, finishReason: null, index: 1 },
      ] }),
      ev({ candidates: [
        { content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0 },
        { content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 1 },
      ] }),
    ];
    const parsed = parse(await run(events));
    ok("multi-candidate index 0 rehydrated", textForIndex(parsed, 0) === `a:${REAL}`, JSON.stringify(textForIndex(parsed, 0)));
    ok("multi-candidate index 1 untouched", textForIndex(parsed, 1) === "b: clean", JSON.stringify(textForIndex(parsed, 1)));
  }

  // ── 5. Clean text is a no-op ──
  {
    const out = await run([ev(cand([{ text: "just plain output" }], "STOP"))]);
    ok("clean text passes through unchanged", textOf(parse(out)) === "just plain output", out);
  }

  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ Gemini rehydration test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
