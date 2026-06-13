/**
 * OpenAI-format integration test (/v1/chat/completions, WYLOC_MASK_SQL=on).
 *
 * Proves the OpenAI adapter reuses the same masking/detector/SQL/rehydration
 * core as the Anthropic path:
 *   • request: a proprietary SQL block + a DB-URL secret in the user message
 *     are masked/scrubbed, an AWS key is swapped to WYLOC_MOCK_, and the
 *     verbatim-echo directive is appended to the system message — while
 *     assistant tool_calls and a role:"tool" message are left byte-intact.
 *   • response: a chat.completion.chunk stream with delta.content (split across
 *     chunks) is rehydrated — both the semantic SQL mask and the WYLOC_MOCK_
 *     token reverse to their real values.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9951;
const GATEWAY_PORT = 9952;
const AWS = "AKIA5XQ2WJ8NPLR3MKVT";

const SQL = [
  "```sql",
  "SELECT p.company_id, m.ghost_probability",
  "FROM job_postings p",
  "JOIN analytics_analytics.mart_ghost_job_index m ON m.job_id = p.job_id",
  "WHERE p.dsn = 'postgres://admin:s3cr3t@prod-db.acme.io:5432/billing'",
  "```",
].join("\n");

const TOOL_ARGS = '{"query":"SELECT 1"}';
const requestObj = {
  model: "gpt-4o",
  stream: true,
  messages: [
    { role: "system", content: "You are a SQL optimizer." },
    { role: "assistant", content: "Running.", tool_calls: [{ id: "call_1", type: "function", function: { name: "run_sql", arguments: TOOL_ARGS } }] },
    { role: "tool", tool_call_id: "call_1", content: "prior result referencing job_postings (must stay)" },
    { role: "user", content: `Optimize this and rotate ${AWS}:\n${SQL}` },
  ],
};

let captured = null;

function chunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function buildSse(text) {
  const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o" };
  let out = chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (let i = 0; i < text.length; i += 5) {
    out += chunk({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 5) }, finish_reason: null }] });
  }
  out += chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  out += "data: [DONE]\n\n";
  return out;
}

function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        captured = Buffer.concat(chunks).toString("utf8");
        const userMsg = JSON.parse(captured).messages.find((m) => m.role === "user").content;
        const fromToken = userMsg.match(/FROM\s+([A-Za-z0-9_]+)/i)?.[1] ?? "UNKNOWN";
        const awsMock = userMsg.match(/WYLOC_MOCK_[A-Z0-9_]+/)?.[0] ?? "WYLOC_MOCK_NONE";
        const sse = buildSse(`Use ${fromToken} and rotate ${awsMock} now.`);
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
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_OPENAI_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
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

function collectText(body) {
  let text = "";
  for (const block of body.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const c = JSON.parse(data).choices?.[0]?.delta?.content;
      if (typeof c === "string") text += c;
    } catch { /* ignore */ }
  }
  return text;
}

async function main() {
  const upstream = await startUpstream();
  const gateway = startGateway();

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }

  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-FAKE" },
    body: JSON.stringify(requestObj),
  });
  const body = await resp.text();

  console.error("\n── OpenAI-format integration assertions ────────────");

  const parsed = JSON.parse(captured);
  const userMsg = parsed.messages.find((m) => m.role === "user").content;
  const toolMsg = parsed.messages.find((m) => m.role === "tool").content;
  const asstMsg = parsed.messages.find((m) => m.role === "assistant");
  const sysMsg = parsed.messages.find((m) => m.role === "system").content;

  // Request side — masking on user text.
  assert(!userMsg.includes("job_postings"), "table 'job_postings' masked in user message");
  assert(!/ghost/i.test(userMsg), "no 'ghost' concept in user message");
  assert(!userMsg.includes(AWS) && /WYLOC_MOCK_/.test(userMsg), "AWS key swapped to WYLOC_MOCK_ in user text");
  assert(!userMsg.includes("s3cr3t") && !userMsg.includes("prod-db.acme.io"), "DB-URL secret scrubbed from SQL literal");

  // Parity — tool-calling structure untouched.
  assert(toolMsg === "prior result referencing job_postings (must stay)", "role:\"tool\" message content left intact");
  assert(asstMsg.tool_calls[0].function.arguments === TOOL_ARGS, "assistant tool_calls.arguments byte-intact");

  // Directive injected into the system message.
  assert(sysMsg.includes("[Wyloc secret-protection notice]"), "verbatim-echo directive appended to system message");

  // Response side — chat.completion.chunk rehydration (both mask types).
  const textOut = collectText(body);
  assert(textOut === `Use job_postings and rotate ${AWS} now.`, "delta.content rehydrated (SQL mask + WYLOC_MOCK_)");
  assert(!/WYLOC_MOCK_/.test(body) && !/postings_[a-z0-9]+/.test(body), "no mask token survives in the response");
  assert(body.trim().endsWith("data: [DONE]"), "stream [DONE] sentinel preserved");

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(process.exitCode ? "\n✗ OpenAI-format integration test FAILED\n" : "\n✓ OpenAI-format integration test PASSED\n");
}

main().catch((err) => { console.error("test error", err); process.exit(1); });
