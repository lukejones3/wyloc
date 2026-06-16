/**
 * Code-masking integration test (WYLOC_MASK_CODE=on). No real Anthropic key.
 *
 * Flow:
 *   1. Client sends a prompt whose user message contains a fenced ```ts block
 *      with proprietary identifiers (class BillingReconciler, function
 *      bootstrap, a relative import), an internal URL, and an AWS-key secret.
 *   2. The gateway masks identifiers + internal infra + strips comments and
 *      swaps the secret BEFORE forwarding, folding real↔mask pairs into the
 *      same store.
 *   3. The fake upstream extracts the masked class token from the request and
 *      streams it back, split across deltas, to exercise rehydration.
 *   4. Assert: the request carries no proprietary identifier / secret / comment;
 *      external imports survive; the streamed reply rehydrates the masked class
 *      back to `BillingReconciler`.
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9943;
const GATEWAY_PORT = 9944;

const CODE = [
  "```ts",
  "// Proprietary billing engine for Project Northstar — do not distribute.",
  'import { useState } from "react";',
  'import { LedgerStore } from "./ledger/store";',
  "",
  "const API_BASE = \"https://billing.internal.acme.com/v2/reconcile\";",
  "const AWS_KEY = \"AKIA5XQ2WJ8NPLR3MKVT\";",
  "",
  "export class BillingReconciler {",
  "  constructor(private store: LedgerStore) {}",
  "  run(): number { return 42; }",
  "}",
  "",
  "export function bootstrap(): BillingReconciler {",
  "  const [n] = useState(0);",
  "  return new BillingReconciler(new LedgerStore());",
  "}",
  "```",
].join("\n");

const requestObj = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [{ role: "user", content: `Review this code:\n${CODE}` }],
  stream: true,
};

let captured = null;

function ev(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE reply that echoes `token` back, split across deltas. */
function buildSse(token) {
  const pieces = ["The class ", token.slice(0, 5), token.slice(5), " holds the logic."];
  let out = ev("message_start", {
    type: "message_start",
    message: { id: "msg_x", type: "message", role: "assistant", content: [], model: "claude-opus-4-8", stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  out += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const p of pieces) {
    out += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } });
  }
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
        const userText = JSON.parse(captured).messages[0].content;
        // Extract the mask token that replaced `class BillingReconciler`.
        const classToken = userText.match(/class\s+(Class_[A-Za-z0-9_]+)/)?.[1] ?? "UNKNOWN_TOKEN";
        const sse = buildSse(classToken);
        res.writeHead(200, { "content-type": "text/event-stream" });
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
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
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

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }

  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(requestObj),
  });
  const body = await resp.text();

  console.error("\n── Code-masking integration assertions ─────────────");

  // Request side: proprietary identity, infra, secret, and comments are gone.
  assert(captured !== null, "upstream received the request");
  assert(!/\bBillingReconciler\b/.test(captured), "class 'BillingReconciler' masked out of request");
  assert(!/\bbootstrap\b/.test(captured), "function 'bootstrap' masked out");
  assert(!/\bLedgerStore\b/.test(captured), "internal import 'LedgerStore' masked out");
  assert(!captured.includes("billing.internal.acme.com"), "internal URL host masked out");
  assert(!captured.includes("AKIA5XQ2WJ8NPLR3MKVT"), "AWS key secret swapped out");
  assert(!captured.includes("Project Northstar") && !captured.includes("do not distribute"), "comment stripped");

  // External / library identifiers preserved — the make-or-break rule.
  assert(/\buseState\b/.test(captured), "external 'useState' preserved");
  assert(/from\s+\\?"react\\?"/.test(captured), "react import path preserved");

  // Response side: the echoed class mask rehydrates back to the real name.
  const events = parseSse(body);
  const textOut = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert(textOut === "The class BillingReconciler holds the logic.", "masked class rehydrated to 'BillingReconciler'");
  assert(!/Class_[a-z0-9]+/.test(body), "no code mask token survives in the response");
  assert(events.at(-1)?.event === "message_stop", "SSE framing intact");

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(process.exitCode ? "\n✗ Code-masking integration test FAILED\n" : "\n✓ Code-masking integration test PASSED\n");
}

main().catch((err) => { console.error("test error", err); process.exit(1); });
