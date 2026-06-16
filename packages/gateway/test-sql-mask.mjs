/**
 * SQL-masking integration test (WYLOC_MASK_SQL=on). No real Anthropic key.
 *
 * Flow:
 *   1. Client sends a prompt whose user message is a fenced ```sql block with
 *      proprietary identifiers (job_postings, analytics_analytics.mart_ghost_
 *      job_index, ghost_probability) and a DB-URL secret in a literal.
 *   2. The gateway masks identifiers + scrubs the literal BEFORE forwarding,
 *      and folds the real↔mask pairs into the same store.
 *   3. The fake upstream extracts the masked FROM token from the request and
 *      streams it back, split across deltas, to exercise rehydration.
 *   4. Assert: the request carries no proprietary identifier / secret, and the
 *      streamed reply rehydrates the masked table back to `job_postings`.
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9941;
const GATEWAY_PORT = 9942;

const SQL = [
  "```sql",
  "SELECT p.company_id, m.ghost_probability",
  "FROM job_postings p",
  "JOIN analytics_analytics.mart_ghost_job_index m ON m.job_id = p.job_id",
  "WHERE p.status = 'active'",
  "  AND p.dsn = 'postgres://admin:s3cr3t@prod-db.acme.io:5432/billing'",
  "```",
].join("\n");

const requestObj = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [{ role: "user", content: `Optimize this query:\n${SQL}` }],
  stream: true,
};

let captured = null;

function ev(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE reply that echoes `token` back, split across deltas. */
function buildSse(token) {
  const pieces = ["The table ", token.slice(0, 4), token.slice(4), " is the bottleneck."];
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
        // Extract the masked identifier that replaced job_postings (the FROM token).
        const fromToken = userText.match(/FROM\s+([A-Za-z0-9_]+)/i)?.[1] ?? "UNKNOWN_TOKEN";
        const sse = buildSse(fromToken);
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
      WYLOC_MASK_SQL: "true",
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

  console.error("\n── SQL-masking integration assertions ──────────────");

  // Request side: proprietary identifiers + secret are gone, a mask is present.
  assert(captured !== null, "upstream received the request");
  assert(!captured.includes("job_postings"), "table 'job_postings' masked out of request");
  assert(!captured.includes("mart_ghost_job_index"), "mart 'mart_ghost_job_index' masked out");
  assert(!captured.includes("analytics_analytics"), "schema 'analytics_analytics' masked out");
  assert(!/ghost/i.test(captured), "no 'ghost' concept anywhere in request");
  assert(!captured.includes("s3cr3t") && !captured.includes("prod-db.acme.io"), "DB-URL secret scrubbed from literal");
  assert(/company_id/.test(captured) && /status/.test(captured), "generic columns preserved");

  // Response side: the echoed mask rehydrates back to the real table name.
  const events = parseSse(body);
  const textOut = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert(textOut === "The table job_postings is the bottleneck.", "masked table rehydrated to 'job_postings'");
  assert(!/postings_[a-z0-9]+/.test(body), "no SQL mask token survives in the response");
  assert(events.at(-1)?.event === "message_stop", "SSE framing intact");

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(process.exitCode ? "\n✗ SQL-masking integration test FAILED\n" : "\n✓ SQL-masking integration test PASSED\n");
}

main().catch((err) => { console.error("test error", err); process.exit(1); });
