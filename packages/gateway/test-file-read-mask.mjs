/**
 * File-read masking integration test (WYLOC_MASK_FILE_READS default on, plus
 * WYLOC_MASK_SQL + WYLOC_MASK_CODE). No real API key.
 *
 * Proves the content of files an agent reads on its own — Anthropic
 * `tool_result` blocks and OpenAI `role:"tool"` messages — is masked the same
 * way typed text is, WITHOUT corrupting tool-call structure:
 *   A. Anthropic tool_result with SQL      → SQL identifiers masked, envelope intact
 *   B. Anthropic tool_result with TS code  → code identifiers masked + round-trip
 *   C. Anthropic tool_result with .env     → secret swapped (detector always runs)
 *   D. OpenAI role:"tool" with a secret    → masked; tool_call_id + tool_calls intact
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9961;
const GATEWAY_PORT = 9962;
const SECRET = "AKIA5XQ2WJ8NPLR3MKVT";

let captured = null;
let capturedPath = null;

function ev(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

/** Anthropic SSE that echoes `token` back, split across deltas (round-trip). */
function anthropicEcho(token) {
  const pieces = ["The class ", token.slice(0, 5), token.slice(5), " is central."];
  let out = ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-opus-4-8", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  out += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const p of pieces) out += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } });
  out += ev("content_block_stop", { type: "content_block_stop", index: 0 });
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
        capturedPath = req.url;
        if (req.url.includes("/chat/completions")) {
          // Minimal OpenAI stream.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        // Anthropic: if the masked request carries a Class_ token, echo it back
        // split across deltas to exercise rehydration; else just stop.
        const m = captured.match(/Class_[A-Za-z0-9]+/);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (m) {
          const bytes = Buffer.from(anthropicEcho(m[0]), "utf8");
          for (let i = 0; i < bytes.length; i += 9) { res.write(bytes.subarray(i, i + 9)); await sleep(1); }
          res.end();
        } else {
          res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        }
      });
    });
    server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_OPENAI_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_MASK_SQL: "true",
      WYLOC_MASK_CODE: "true",
      WYLOC_VERBOSE: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
  else console.error(`  ✓ ${msg}`);
}

async function send(path, obj) {
  const isOpenAi = path.includes("chat");
  const headers = isOpenAi
    ? { "content-type": "application/json", "authorization": "Bearer sk-FAKE" }
    : { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" };
  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, { method: "POST", headers, body: JSON.stringify(obj) });
  return resp.text();
}

function parseSse(body) {
  return body.split("\n\n").filter((b) => b.trim()).map((block) => {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const dataStr = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    let data = null; try { data = JSON.parse(dataStr); } catch {}
    return { event, data };
  });
}

async function main() {
  const upstream = await startUpstream();
  const gateway = startGateway();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {} await sleep(100); }

  // ── A. Anthropic tool_result with SQL ────────────────────────────────
  console.error("\n── A. Anthropic tool_result: SQL file ──────────────");
  await send("/v1/messages", {
    model: "claude-opus-4-8", max_tokens: 32, stream: true,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "read_file", input: { file_path: "q.sql" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a",
        content: "SELECT p.company_id, m.ghost_probability FROM job_postings p JOIN analytics_analytics.mart_ghost_job_index m ON m.job_id = p.job_id" }] },
    ],
  });
  {
    const o = JSON.parse(captured);
    const tr = o.messages[1].content[0];
    assert(!captured.includes("job_postings"), "A: 'job_postings' masked out of tool_result");
    assert(!captured.includes("mart_ghost_job_index"), "A: mart masked out");
    assert(!/ghost/i.test(captured), "A: no 'ghost' concept anywhere");
    assert(captured.includes("company_id"), "A: generic column preserved");
    assert(tr.type === "tool_result" && tr.tool_use_id === "toolu_a", "A: tool_result envelope intact");
    assert(JSON.stringify(o.messages[0].content[0].input) === JSON.stringify({ file_path: "q.sql" }), "A: tool_use.input byte-intact");
  }

  // ── B. Anthropic tool_result with TS code (+ round-trip) ─────────────
  console.error("\n── B. Anthropic tool_result: TS file + round-trip ──");
  const tsFile = [
    "// Proprietary billing engine — do not distribute.",
    'import { useState } from "react";',
    'import { LedgerStore } from "./ledger/store";',
    `const API_BASE = "https://billing.internal.acme.com/v2";`,
    `const AWS_KEY = "${SECRET}";`,
    "export class BillingReconciler {",
    "  constructor(private store: LedgerStore) {}",
    "}",
    "export function bootstrap(): BillingReconciler {",
    "  const [n] = useState(0);",
    "  return new BillingReconciler(new LedgerStore());",
    "}",
  ].join("\n");
  const bodyB = await send("/v1/messages", {
    model: "claude-opus-4-8", max_tokens: 32, stream: true,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_b", name: "read_file", input: { file_path: "billing.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: tsFile }] },
    ],
  });
  {
    const o = JSON.parse(captured);
    const tr = o.messages[1].content[0];
    assert(!/\bBillingReconciler\b/.test(captured), "B: class 'BillingReconciler' masked");
    assert(!/\bLedgerStore\b/.test(captured), "B: internal import 'LedgerStore' masked");
    assert(!captured.includes("billing.internal.acme.com"), "B: internal URL masked");
    assert(!captured.includes(SECRET), "B: AWS secret swapped");
    assert(!captured.includes("do not distribute"), "B: comment stripped");
    assert(/useState/.test(captured), "B: external 'useState' preserved");
    assert(tr.type === "tool_result" && tr.tool_use_id === "toolu_b", "B: tool_result envelope intact");
    // round-trip: the echoed Class_ token rehydrates back to BillingReconciler
    const text = parseSse(bodyB).filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
    assert(text === "The class BillingReconciler is central.", "B: masked class rehydrated in response");
    assert(!/Class_[a-z0-9]/.test(bodyB), "B: no code mask token survives in response");
  }

  // ── C. Anthropic tool_result with .env (plain, not SQL/code) ─────────
  console.error("\n── C. Anthropic tool_result: .env file ─────────────");
  await send("/v1/messages", {
    model: "claude-opus-4-8", max_tokens: 32, stream: true,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_c", name: "read_file", input: { file_path: ".env" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c", content: `# config\nAWS_KEY=${SECRET}\nLOG_LEVEL=debug` }] },
    ],
  });
  {
    const o = JSON.parse(captured);
    const tr = o.messages[1].content[0];
    assert(!captured.includes(SECRET), "C: secret in .env swapped (detector always runs on plain files)");
    assert(tr.content.includes("WYLOC_MOCK_"), "C: tool_result carries a mock");
    assert(tr.content.includes("LOG_LEVEL=debug"), "C: non-secret lines preserved");
    assert(tr.type === "tool_result" && tr.tool_use_id === "toolu_c", "C: tool_result envelope intact");
  }

  // ── D. OpenAI role:"tool" message ────────────────────────────────────
  console.error("\n── D. OpenAI role:tool message ─────────────────────");
  const TOOL_ARGS = '{"file_path": "/etc/app/.env"}';
  await send("/v1/chat/completions", {
    model: "gpt-4o", stream: true,
    messages: [
      { role: "user", content: "read the env file" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: TOOL_ARGS } }] },
      { role: "tool", tool_call_id: "call_9", content: `AWS_KEY=${SECRET}\nGREETING=hello` },
    ],
  });
  {
    const o = JSON.parse(captured);
    const toolMsg = o.messages.find((m) => m.role === "tool");
    const asst = o.messages.find((m) => m.role === "assistant");
    assert(!captured.includes(SECRET), "D: secret in role:tool content swapped");
    assert(toolMsg.content.includes("WYLOC_MOCK_") && toolMsg.content.includes("GREETING=hello"), "D: tool content masked, rest preserved");
    assert(toolMsg.tool_call_id === "call_9", "D: tool_call_id preserved");
    assert(asst.tool_calls[0].id === "call_9" && asst.tool_calls[0].function.name === "read_file", "D: assistant tool_calls id/name intact");
    assert(asst.tool_calls[0].function.arguments === TOOL_ARGS, "D: tool_calls.function.arguments byte-intact");
  }

  upstream.close();
  gateway.kill("SIGTERM");
  console.error(process.exitCode ? "\n✗ File-read masking integration test FAILED\n" : "\n✓ File-read masking integration test PASSED\n");
}

main().catch((err) => { console.error("test error", err); process.exit(1); });
