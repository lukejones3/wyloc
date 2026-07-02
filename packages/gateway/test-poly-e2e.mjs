/**
 * Poly-language END-TO-END proxy test (Go + Python), against a fake SSE
 * upstream. The automated proxy-level proof for the poly languages, mirroring
 * the live-smoke harness used for Gemini/Aider — the hardening pass BEFORE a
 * real-agent/real-provider live run.
 *
 * Per language it drives the FULL request→response cycle:
 *   REQUEST  — a real .go / .py file (internal package + import, internal
 *              type/func, an internal URL, and a hardcoded AWS secret) routed
 *              through the gateway. Asserts the forwarded-upstream body has the
 *              internal identity masked, the internal host masked, the secret
 *              swapped to WYLOC_MOCK_, and external/stdlib identifiers intact.
 *   RESPONSE — the fake upstream echoes the gateway's own masks back in an SSE
 *              stream with each token SPLIT ACROSS content_block_delta events
 *              (and the raw bytes chunked small), exercising the response-side
 *              token-boundary buffering. Asserts the streamed text rehydrates
 *              to the REAL identifier AND the REAL secret.
 *
 * Both surfaces are covered: the FENCED-block path (```go / ```py in a user
 * message) and the FILE-READ / content-router path (a tool_result the agent
 * "read"). No real Anthropic key; the binary/gateway runs from source via tsx.
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UP_PORT = 9971;
const GW_PORT = 9972;

const AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT";
const INTERNAL_HOST = "ledger.internal.voltra.io";

// ── Real-shaped source files ────────────────────────────────────────────────
const GO_FILE = [
  "// Package billing reconciles Voltra invoices. Proprietary.",
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
  "func NewInvoiceReconciler(lc *ledger.Client) *InvoiceReconciler {",
  "\treturn &InvoiceReconciler{ledgerClient: lc, httpClient: http.DefaultClient}",
  "}",
  "",
  "func RegisterRoutes(rg *gin.RouterGroup, r *InvoiceReconciler) {",
  '\trg.POST("/reconcile", func(c *gin.Context) { fmt.Println(r != nil) })',
  "}",
].join("\n");

const PY_FILE = [
  '"""Voltra billing reconciliation service. Proprietary."""',
  "import logging",
  "",
  "import requests",
  "",
  "from voltra_billing.ledger import LedgerClient",
  "",
  "log = logging.getLogger(__name__)",
  'LEDGER_BASE_URL = "https://ledger.internal.voltra.io/api/v3"',
  'AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT"',
  "",
  "",
  "class InvoiceReconciler:",
  "    def __init__(self, ledger_client: LedgerClient):",
  "        self.ledger_client = ledger_client",
  "        self.session = requests.Session()",
  "",
  "    def reconcile_batch(self, batch_id):",
  "        self.ledger_client.post_entry(batch_id)",
  "        log.info('posted %s', batch_id)",
  "        return batch_id",
].join("\n");

// ── SSE helpers ─────────────────────────────────────────────────────────────
function ev(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build an SSE reply that says "The type <CLS> holds key <SEC>." where <CLS>
 * and <SEC> are the gateway's OWN masks — each split across TWO adjacent
 * text_delta events, so the response-side rehydration must reassemble a token
 * fragmented across deltas before reversing it.
 */
function buildSse(classMask, secretMock) {
  const half = (s) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];
  const [c1, c2] = half(classMask);
  const [s1, s2] = half(secretMock);
  const pieces = ["The type ", c1, c2, " holds key ", s1, s2, " now."];
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

let captured = null;
function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        captured = Buffer.concat(chunks).toString("utf8");
        // Extract the gateway's own masks to echo back, split across deltas.
        // The class/struct mask (Class_…) and the AWS secret mock — target the
        // AWS-labelled mock specifically (other WYLOC_MOCK_ tokens exist, e.g.
        // the internal-URL env-assignment mock; grabbing the first would be
        // non-deterministic across languages).
        const classMask = captured.match(/Class_[A-Za-z0-9_]+/)?.[0] ?? "Class_MISSING";
        const secretMock = captured.match(/WYLOC_MOCK_AWS[A-Z0-9_]*/)?.[0]
          ?? captured.match(/WYLOC_MOCK_[A-Z0-9_]+/)?.[0] ?? "WYLOC_MOCK_MISSING";
        const sse = buildSse(classMask, secretMock);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Chunk the RAW bytes small so SSE frames also span network writes.
        const bytes = Buffer.from(sse, "utf8");
        for (let i = 0; i < bytes.length; i += 6) {
          res.write(bytes.subarray(i, i + 6));
          await sleep(1);
        }
        res.end();
      });
    });
    server.listen(UP_PORT, "127.0.0.1", () => resolve(server));
  });
}

function startGateway(configPath) {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GW_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      // No `languages` key in the config → the DEFAULT language set applies
      // (go + python are in it), so this also exercises that the sensible
      // default masks out of the box. The config only supplies the
      // internal-package prefixes (the internal-vs-external signal).
      WYLOC_CONFIG: configPath,
      WYLOC_VERBOSE: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (!cond) { fail++; console.error(`  ✗ FAIL: ${msg}`); } else { pass++; console.error(`  ✓ ${msg}`); }
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

async function post(body) {
  const resp = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return resp.text();
}

function streamedText(body) {
  return parseSse(body)
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
}

/** A request whose user message contains `code` in a fenced block. */
function fencedReq(tag, code) {
  return { model: "claude-opus-4-8", max_tokens: 64, stream: true,
    messages: [{ role: "user", content: "review:\n```" + tag + "\n" + code + "\n```" }] };
}

/** A request whose LAST message is a tool_result carrying `code` (file read). */
function fileReadReq(path, code) {
  return { model: "claude-opus-4-8", max_tokens: 64, stream: true, messages: [
    { role: "user", content: "read " + path },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: code }] }] },
  ] };
}

/** Assert the forwarded request masked internals/host/secret, kept externals. */
function assertRequestMasked(tag, { internals, externals, isFileRead }) {
  const body = isFileRead ? JSON.parse(captured).messages[2].content[0].content[0].text : captured;
  for (const name of internals) assert(!new RegExp(`\\b${name}\\b`).test(body), `[${tag}] internal '${name}' masked out`);
  assert(!body.includes(INTERNAL_HOST), `[${tag}] internal host masked out`);
  assert(!body.includes(AWS_KEY), `[${tag}] AWS secret swapped out`);
  assert(body.includes("WYLOC_MOCK_"), `[${tag}] secret mock present`);
  for (const name of externals) assert(new RegExp(`\\b${name}\\b`).test(body), `[${tag}] external '${name}' preserved`);
}

/** Assert the streamed response rehydrated the real identifier + secret. */
function assertResponseRehydrated(tag, realClass) {
  const text = streamedText(lastBody);
  assert(text === `The type ${realClass} holds key ${AWS_KEY} now.`,
    `[${tag}] split-across-deltas mask + secret mock rehydrated to real values`);
}

let lastBody = "";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "wyloc-e2e-"));
  // Supply the internal-package prefixes (the internal-vs-external signal) so
  // internal imports classify correctly; omit `languages` → default set.
  const configPath = join(dir, "wyloc.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    internalPackagePrefixes: {
      go: ["github.com/voltra/billing-core"],
      python: ["voltra_billing"],
    },
  }));
  const upstream = await startUpstream();
  const gateway = startGateway(configPath);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${GW_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }

  // ── Go via the FENCED path (full request→response cycle) ──────────────────
  console.error("\n── Go: fenced block, request masked + response rehydrated ──");
  captured = null;
  lastBody = await post(fencedReq("go", GO_FILE));
  assertRequestMasked("go/fenced", {
    internals: ["InvoiceReconciler", "NewInvoiceReconciler", "RegisterRoutes", "billing"],
    externals: ["gin", "fmt", "http"],
    isFileRead: false,
  });
  assert(!captured.includes("voltra/billing-core"), "[go/fenced] internal import path masked out");
  assertResponseRehydrated("go/fenced", "InvoiceReconciler");

  // ── Go via the FILE-READ path (request masking) ───────────────────────────
  console.error("\n── Go: file-read (tool_result), request masked ──");
  captured = null;
  await post(fileReadReq("reconciler.go", GO_FILE));
  assertRequestMasked("go/file-read", {
    internals: ["InvoiceReconciler", "RegisterRoutes"],
    externals: ["gin", "fmt", "http"],
    isFileRead: true,
  });
  const goToolCall = JSON.parse(captured).messages[1].content[0];
  assert(goToolCall.type === "tool_use" && goToolCall.id === "tu_1", "[go/file-read] tool-call envelope untouched");

  // ── Python via the FILE-READ path (full request→response cycle) ───────────
  console.error("\n── Python: file-read, request masked + response rehydrated ──");
  captured = null;
  lastBody = await post(fileReadReq("reconciler.py", PY_FILE));
  assertRequestMasked("py/file-read", {
    // InvoiceReconciler = declared class; LedgerClient = internal-import binding;
    // voltra_billing = internal module (prefix-classified). reconcile_batch is a
    // METHOD → deliberately NOT masked (dynamic-typing member rule).
    internals: ["InvoiceReconciler", "LedgerClient", "voltra_billing"],
    externals: ["requests", "logging"],
    isFileRead: true,
  });
  assert(/\breconcile_batch\b/.test(JSON.parse(captured).messages[2].content[0].content[0].text),
    "[py/file-read] method 'reconcile_batch' left untouched (members off)");
  assertResponseRehydrated("py/file-read", "InvoiceReconciler");

  // ── Python via the FENCED path (request masking) ──────────────────────────
  console.error("\n── Python: fenced block, request masked ──");
  captured = null;
  await post(fencedReq("py", PY_FILE));
  assertRequestMasked("py/fenced", {
    internals: ["InvoiceReconciler", "LedgerClient", "voltra_billing"],
    externals: ["requests", "logging"],
    isFileRead: false,
  });

  gateway.kill("SIGTERM");
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
  await sleep(200);
  console.error(`\n${fail === 0 ? "✓" : "✗"} poly e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
