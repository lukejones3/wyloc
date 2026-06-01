/**
 * Phase 3 end-to-end round-trip test (no real Anthropic key needed).
 *
 * Flow:
 *   1. Client sends a prompt containing a real AWS key through the gateway.
 *   2. The gateway swaps it to a WYLOC_MOCK_ token (Phase 2) and injects
 *      the verbatim-echo system directive (Phase 3).
 *   3. The fake upstream reads the mock the gateway produced and streams
 *      an SSE reply that echoes that mock back — deliberately SPLIT across
 *      multiple text_delta events AND flushed in tiny byte chunks — plus a
 *      tool_use block with input_json_delta.
 *   4. The client asserts the streamed reply now contains the REAL secret
 *      (rehydrated), no mock survives, tool input_json_delta is untouched,
 *      and SSE framing/event sequence is intact.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9931;
const GATEWAY_PORT = 9932;
const SECRET = "AKIA5XQ2WJ8NPLR3MKVT";

const requestObj = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: `Rotate my key ${SECRET} please.` }],
  stream: true,
};

let captured = null;

/** Build the SSE reply that echoes `mock` back, split across deltas. */
function buildSse(mock) {
  // Split the mock into 3 uneven pieces to exercise cross-delta buffering.
  const a = mock.slice(0, 4);
  const b = mock.slice(4, 15);
  const c = mock.slice(15);
  const textPieces = ["Your key is ", a, b, c, " — rotated."];

  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = "";
  out += ev("message_start", {
    type: "message_start",
    message: { id: "msg_x", type: "message", role: "assistant", content: [], model: "claude-opus-4-8", stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  // text block (index 0)
  out += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  out += ev("ping", { type: "ping" });
  for (const piece of textPieces) {
    out += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
  }
  out += ev("content_block_stop", { type: "content_block_stop", index: 0 });
  // tool_use block (index 1) with split input_json_delta — must be untouched
  out += ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "write_file", input: {} } });
  out += ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } });
  out += ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "/etc/app"}' } });
  out += ev("content_block_stop", { type: "content_block_stop", index: 1 });
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev("message_stop", { type: "message_stop" });
  return out;
}

function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        captured = Buffer.concat(chunks).toString("utf8");
        // Pull the mock from the USER MESSAGE specifically — the injected
        // system directive also contains an illustrative WYLOC_MOCK_ token.
        const parsed = JSON.parse(captured);
        const userText = parsed.messages[0].content;
        const mock = userText.match(/WYLOC_MOCK_[A-Z0-9_]+/)?.[0];
        const sse = buildSse(mock ?? "WYLOC_MOCK_NONE_000000");
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Flush the SSE in tiny byte chunks to exercise chunk-boundary
        // splitting (events and the mock get split mid-line on the wire).
        const bytes = Buffer.from(sse, "utf8");
        for (let i = 0; i < bytes.length; i += 7) {
          res.write(bytes.subarray(i, i + 7));
          await sleep(1);
        }
        res.end();
      });
    });
    server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_VERBOSE: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
  else console.error(`  ✓ ${msg}`);
}

/** Parse an SSE body into [{event, data}]. */
function parseSse(body) {
  return body
    .split("\n\n")
    .filter((b) => b.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dataStr = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      let data = null;
      try { data = JSON.parse(dataStr); } catch {}
      return { event, data };
    });
}

async function main() {
  const upstream = await startUpstream();
  const gateway = startGateway();

  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }

  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(requestObj),
  });
  const body = await resp.text();

  console.error("\n── Phase 3 round-trip assertions ───────────────────");

  // Request side (Phase 2 + injection still in force).
  assert(captured?.includes("WYLOC_MOCK_"), "upstream request carried a mock (swap fired)");
  assert(!captured?.includes(SECRET), "upstream request did NOT carry the real secret");
  assert(captured?.includes("[Wyloc secret-protection notice]"), "system directive injected into upstream request");

  // Response side (Phase 3 rehydration).
  const events = parseSse(body);
  const textOut = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");

  assert(textOut === `Your key is ${SECRET} — rotated.`, "streamed text rehydrated to the REAL secret");
  assert(!body.includes("WYLOC_MOCK_"), "no mock token survives anywhere in the response");
  assert(body.includes(SECRET), "real secret present in the response stream");

  // Tool input_json_delta must be byte-intact.
  const toolJson = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta")
    .map((e) => e.data.delta.partial_json)
    .join("");
  assert(toolJson === '{"path": "/etc/app"}', "tool_use input_json_delta preserved byte-intact");

  // Framing / sequence intact.
  const seq = events.map((e) => e.event);
  assert(seq[0] === "message_start", "message_start preserved first");
  assert(seq.includes("ping"), "ping event preserved");
  assert(seq.filter((e) => e === "content_block_start").length === 2, "both content_block_start events preserved");
  assert(seq.filter((e) => e === "content_block_stop").length === 2, "both content_block_stop events preserved");
  assert(seq.at(-1) === "message_stop", "message_stop preserved last");
  assert(events.every((e) => e.data !== null), "every emitted event has valid JSON data (framing intact)");

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(process.exitCode ? "\n✗ Phase 3 round-trip test FAILED\n" : "\n✓ Phase 3 round-trip test PASSED\n");
}

main().catch((err) => { console.error("test error", err); process.exit(1); });
