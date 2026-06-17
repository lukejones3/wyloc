/**
 * Responses API request-masking integration test (Phase 2).
 * WYLOC_MASK_SQL + WYLOC_MASK_CODE on. No real API key.
 *
 * Proves /v1/responses is masked (no longer passthrough):
 *   - instructions + input_text + output_text parts → masked (the new predicate)
 *   - fenced SQL in input → SQL-masked
 *   - function_call_output (a read .ts file) → full file-read treatment (code + secret)
 *   - function_call (args/call_id/name) and reasoning items → BYTE-INTACT
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UP = 9970, GW = 9971, SECRET = "AKIA5XQ2WJ8NPLR3MKVT";
let captured = null;

const req = {
  model: "gpt-5-codex", stream: true,
  instructions: `You are helpful. Deploy key ${SECRET} keep it safe.`,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "optimize:\n```sql\nSELECT id FROM secret_ledger\n```" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `earlier the key ${SECRET} appeared` }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"/etc/app/.env"}' },
    { type: "function_call_output", call_id: "call_1", output: `export class LedgerStore {\n  key = "${SECRET}";\n}` },
    { type: "reasoning", id: "rs_1", summary: [] },
  ],
};

function ev(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }
function startUpstream() {
  return new Promise((resolve) => {
    const s = createServer((rq, rs) => {
      const c = []; rq.on("data", (x) => c.push(x));
      rq.on("end", () => {
        captured = Buffer.concat(c).toString("utf8");
        // Round-trip: echo the gateway-produced mock back, split across deltas +
        // the terminal full-text payloads, so rehydration is exercised end-to-end.
        const mock = (captured.match(/WYLOC_MOCK_[A-Z0-9_]+/) || ["WYLOC_MOCK_NONE"])[0];
        const full = `The deploy key ${mock} is set.`;
        rs.writeHead(200, { "content-type": "text/event-stream" });
        rs.write(ev("response.output_text.delta", { item_id: "m", content_index: 0, delta: `The deploy key ${mock.slice(0, 11)}` }));
        rs.write(ev("response.output_text.delta", { item_id: "m", content_index: 0, delta: `${mock.slice(11)} is set.` }));
        rs.write(ev("response.output_text.done", { item_id: "m", content_index: 0, text: full }));
        rs.write(ev("response.completed", { response: { output: [{ type: "message", content: [{ type: "output_text", text: full }] }] } }));
        rs.end();
      });
    });
    s.listen(UP, "127.0.0.1", () => resolve(s));
  });
}
function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, WYLOC_GATEWAY_PORT: String(GW), WYLOC_OPENAI_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP}`, WYLOC_MASK_SQL: "true", WYLOC_MASK_CODE: "true", WYLOC_VERBOSE: "true" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

async function main() {
  const up = await startUpstream();
  const gw = startGateway();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) break; } catch {} await sleep(100); }
  await sleep(1500); // let the sqlglot worker warm up

  const resp = await fetch(`http://127.0.0.1:${GW}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer sk-FAKE" },
    body: JSON.stringify(req),
  }).catch(() => null);
  const respBody = resp ? await resp.text() : "";
  await sleep(300);

  console.error("\n── Responses request-masking assertions ──");
  ok("upstream received the request", captured !== null);
  const o = captured ? JSON.parse(captured) : {};

  // instructions (system-equivalent) masked
  ok("instructions secret masked", typeof o.instructions === "string" && !o.instructions.includes(SECRET) && o.instructions.includes("WYLOC_MOCK_"));

  // input_text part masked (SQL)
  const userText = o.input?.[0]?.content?.[0]?.text ?? "";
  ok("input_text SQL table masked", !userText.includes("secret_ledger"), userText);

  // output_text part masked (proves the predicate walks assistant history too)
  const asstText = o.input?.[1]?.content?.[0]?.text ?? "";
  ok("output_text secret masked (predicate works)", !asstText.includes(SECRET) && asstText.includes("WYLOC_MOCK_"), asstText);

  // function_call ENVELOPE byte-intact
  const fc = o.input?.[2] ?? {};
  ok("function_call.call_id intact", fc.call_id === "call_1");
  ok("function_call.name intact", fc.name === "read_file");
  ok("function_call.arguments byte-intact", fc.arguments === '{"path":"/etc/app/.env"}');

  // function_call_output gets full file-read treatment (code + secret), envelope intact
  const fco = o.input?.[3] ?? {};
  ok("function_call_output envelope intact", fco.type === "function_call_output" && fco.call_id === "call_1");
  ok("function_call_output: secret swapped", typeof fco.output === "string" && !fco.output.includes(SECRET));
  ok("function_call_output: code identifier masked (file-read code-mask)", typeof fco.output === "string" && !/\bLedgerStore\b/.test(fco.output), fco.output);

  // reasoning item intact
  const rz = o.input?.[4] ?? {};
  ok("reasoning item intact", rz.type === "reasoning" && rz.id === "rs_1");

  // ── round-trip: streamed response rehydrates back to the real secret ──
  ok("response stream rehydrated to real secret", respBody.includes(SECRET), respBody.slice(0, 200));
  ok("no mock token survives in the response", !respBody.includes("WYLOC_MOCK_"));

  gw.kill("SIGTERM"); up.close();
  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ Responses request-masking test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
