/**
 * Poly-masking (Go) integration test. No real Anthropic key.
 *
 * Configures the gateway via a temp wyloc.json (`languages: ["go"]` +
 * `internalPackagePrefixes.go`) and exercises BOTH poly surfaces in one run:
 *
 *   1. FENCED PATH: a user message with a ```go block containing proprietary
 *      identifiers (type InvoiceReconciler, func NewInvoiceReconciler, an
 *      internal import), an internal URL, an AWS key, and comments. Assert the
 *      forwarded request carries none of them, externals survive, and the
 *      streamed reply rehydrates the struct mask back to the real name.
 *
 *   2. FILE-READ PATH: a tool_result whose text is a RAW Go file (no fence).
 *      The content-router must sniff it as Go and mask it the same way.
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9961;
const GATEWAY_PORT = 9962;

const GO_FILE = [
  "// Package billing implements Voltra's reconciliation pipeline. Proprietary.",
  "package billing",
  "",
  "import (",
  '\t"fmt"',
  '\t"net/http"',
  "",
  '\t"github.com/gin-gonic/gin"',
  '\t"github.com/voltra/billing-core/internal/ledger"',
  ")",
  "",
  'const ledgerBaseURL = "https://ledger.internal.voltra.io/api/v3"',
  'const awsAccessKey = "AKIA5XQ2WJ8NPLR3MKVT"',
  "",
  "// InvoiceReconciler matches payments against open invoices.",
  "type InvoiceReconciler struct {",
  "\tledgerClient *ledger.Client",
  "\thttpClient   *http.Client",
  "}",
  "",
  "// NewInvoiceReconciler wires a reconciler.",
  "func NewInvoiceReconciler(lc *ledger.Client) *InvoiceReconciler {",
  "\treturn &InvoiceReconciler{ledgerClient: lc, httpClient: http.DefaultClient}",
  "}",
  "",
  "func RegisterRoutes(rg *gin.RouterGroup, r *InvoiceReconciler) {",
  '\trg.POST("/reconcile", func(c *gin.Context) {',
  '\t\tfmt.Println("ok", r != nil)',
  "\t})",
  "}",
].join("\n");

const fencedRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [{ role: "user", content: "Review this code:\n```go\n" + GO_FILE + "\n```" }],
  stream: true,
};

const fileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "reconciler.go" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: GO_FILE }] }],
    },
  ],
  stream: true,
};

let captured = null;

function ev(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE reply that echoes `token` back, split across deltas. */
function buildSse(token) {
  const pieces = ["The type ", token.slice(0, 4), token.slice(4), " drives it."];
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
        const typeToken = captured.match(/(Class_[A-Za-z0-9_]+)/)?.[1] ?? "UNKNOWN_TOKEN";
        const sse = buildSse(typeToken);
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

function startGateway(wylocPath) {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_CONFIG: wylocPath,
      WYLOC_VERBOSE: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
  else console.error(`  ✓ ${msg}`);
}

function assertMaskedGo(tag) {
  assert(captured !== null, `${tag} upstream received the request`);
  assert(!/\bInvoiceReconciler\b/.test(captured), `${tag} type 'InvoiceReconciler' masked out`);
  assert(!/\bNewInvoiceReconciler\b/.test(captured), `${tag} func 'NewInvoiceReconciler' masked out`);
  assert(!/\bRegisterRoutes\b/.test(captured), `${tag} func 'RegisterRoutes' masked out`);
  assert(!captured.includes("voltra/billing-core"), `${tag} internal import path masked out`);
  assert(!captured.includes("ledger.internal.voltra.io"), `${tag} internal URL host masked out`);
  assert(!captured.includes("AKIA5XQ2WJ8NPLR3MKVT"), `${tag} AWS key secret swapped out`);
  assert(!captured.includes("Proprietary") && !captured.includes("matches payments"), `${tag} comments stripped`);
  // External / stdlib identifiers preserved — the make-or-break rule.
  assert(/\bgin\b/.test(captured), `${tag} external 'gin' preserved`);
  assert(captured.includes("github.com/gin-gonic/gin"), `${tag} external import path preserved`);
  assert(/\bRouterGroup\b/.test(captured), `${tag} external 'RouterGroup' preserved`);
  assert(captured.includes("http.Client"), `${tag} stdlib 'http.Client' preserved`);
  assert(/\bfmt\b/.test(captured), `${tag} stdlib 'fmt' preserved`);
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

async function post(body) {
  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return resp.text();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "wyloc-poly-gw-"));
  const wylocPath = join(dir, "wyloc.json");
  writeFileSync(
    wylocPath,
    JSON.stringify({
      version: 1,
      languages: ["go"],
      internalPackagePrefixes: { go: ["github.com/voltra/billing-core"] },
    }),
  );

  const upstream = await startUpstream();
  const gateway = startGateway(wylocPath);

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }

  console.error("\n── Poly-masking (Go): fenced-block path ─────────────");
  captured = null;
  const body1 = await post(fencedRequest);
  assertMaskedGo("[fenced]");

  // Response side: the echoed type mask rehydrates back to the real name.
  const textOut = parseSse(body1)
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert(textOut === "The type InvoiceReconciler drives it.", "[fenced] masked type rehydrated to 'InvoiceReconciler'");

  console.error("\n── Poly-masking (Go): file-read (tool_result) path ──");
  captured = null;
  await post(fileReadRequest);
  assertMaskedGo("[file-read]");
  const parsed = JSON.parse(captured);
  const toolResult = parsed.messages[2].content[0];
  assert(toolResult.type === "tool_result" && toolResult.tool_use_id === "tu_1", "[file-read] tool-call envelope untouched");

  gateway.kill("SIGTERM");
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
  await sleep(200);
  console.error(process.exitCode ? "\nFAILED" : "\nOK");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
