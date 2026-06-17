/**
 * Responses API rehydration unit tests (Phase 3).
 * Run with: node --import tsx test-responses-rehydrate.mjs
 *
 * Feeds a synthetic Responses SSE stream (mock embedded, split across deltas)
 * through rehydrateResponsesStream and asserts: incremental deltas rehydrate
 * (split mock reassembled), the terminal output_text.done full text rehydrates,
 * response.completed's aggregated text rehydrates (no leak), function-call
 * argument structure passes through untouched, and clean text is a no-op.
 */
import { rehydrateResponsesStream } from "./src/sse-rehydrate-responses.ts";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

const REAL = "AKIA5XQ2WJ8NPLR3MKVT";
const MOCK = "WYLOC_MOCK_AWS_ACCESS_KEY_ABC123";
const mappings = [{ real: REAL, mock: MOCK }];

function ev(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }

async function run(events) {
  const enc = new TextEncoder();
  async function* src() { for (const e of events) yield enc.encode(e); }
  let out = "";
  for await (const c of rehydrateResponsesStream(src(), mappings)) out += new TextDecoder().decode(c);
  return out;
}
function parse(out) {
  return out.split("\n\n").filter((b) => b.trim()).map((blk) => {
    const data = blk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    try { return JSON.parse(data); } catch { return { raw: blk }; }
  });
}

async function main() {
  // ── 1. Split-mock across deltas + terminal full text (done + completed) ──
  const fullMock = `The key is ${MOCK} now.`;
  const fullReal = `The key is ${REAL} now.`;
  const events = [
    ev("response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "The key is WYLOC_MOCK_AWS" }),
    ev("response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "_ACCESS_KEY_" }),
    ev("response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "ABC123 now." }),
    ev("response.output_text.done", { item_id: "msg_1", content_index: 0, text: fullMock }),
    ev("response.completed", { response: { output: [{ type: "message", content: [{ type: "output_text", text: fullMock }] }] } }),
  ];
  const out = await run(events);
  const parsed = parse(out);

  const deltas = parsed.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  ok("split mock across deltas rehydrates intact", deltas === fullReal, JSON.stringify(deltas));
  ok("no mock token anywhere in output", !out.includes("WYLOC_MOCK_"));

  const done = parsed.find((e) => e.type === "response.output_text.done");
  ok("output_text.done full text rehydrated", done?.text === fullReal, JSON.stringify(done?.text));

  const completed = parsed.find((e) => e.type === "response.completed");
  ok("response.completed aggregated text rehydrated (no terminal leak)",
    completed?.response?.output?.[0]?.content?.[0]?.text === fullReal, JSON.stringify(completed?.response));

  // ── 2. Function-call argument structure passes through untouched ──
  {
    const args = `{"path":"${MOCK}"}`; // a mock-looking value inside tool-call args
    const o = await run([ev("response.function_call_arguments.delta", { item_id: "fc_1", delta: args })]);
    const p = parse(o).find((e) => e.type === "response.function_call_arguments.delta");
    ok("function-call args structure NOT rehydrated (passthrough)", p?.delta === args, JSON.stringify(p?.delta));
  }

  // ── 3. Clean text is a no-op ──
  {
    const o = await run([
      ev("response.output_text.delta", { item_id: "m", content_index: 0, delta: "just plain output" }),
      ev("response.output_text.done", { item_id: "m", content_index: 0, text: "just plain output" }),
    ]);
    const d = parse(o).filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    ok("clean text passes through unchanged", d === "just plain output", JSON.stringify(d));
  }

  // ── 4. Lifecycle/other events pass through byte-intact ──
  {
    const lc = ev("response.created", { response: { id: "resp_1" } });
    const o = await run([lc]);
    ok("lifecycle event passes through", o.includes('"response.created"') && o.includes("resp_1"));
  }

  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ Responses rehydration test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
