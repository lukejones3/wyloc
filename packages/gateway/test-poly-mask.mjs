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
 *
 *   3. SNIFF PRECEDENCE (Java vs TS): with policy.code (TS/JS) ON, a RAW Java
 *      file must still route to the poly-masker (`package x.y;` sniff), not be
 *      parsed as TypeScript by the loose looksLikeCode() sniff — internal
 *      names masked, slf4j/Spring untouched.
 *
 *   4. C# PROJECT INDEX + 5. KOTLIN SNIFF: see per-scenario sections.
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

const JAVA_FILE = [
  "// Voltra billing — reconciliation service. Proprietary.",
  "package com.voltra.billing;",
  "",
  "import java.util.List;",
  "import org.slf4j.Logger;",
  "import org.slf4j.LoggerFactory;",
  "import com.voltra.ledger.LedgerClient;",
  "",
  "public class InvoiceReconciler {",
  "    private static final Logger log = LoggerFactory.getLogger(InvoiceReconciler.class);",
  "    private final LedgerClient ledgerClient;",
  "",
  "    public InvoiceReconciler(LedgerClient ledgerClient) {",
  "        this.ledgerClient = ledgerClient;",
  "    }",
  "",
  "    public int reconcile(List<String> batchIds) {",
  "        for (String id : batchIds) {",
  "            ledgerClient.postEntry(id);",
  "        }",
  "        log.info(\"posted {} entries\", batchIds.size());",
  "        return batchIds.size();",
  "    }",
  "}",
].join("\n");

const javaFileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the java reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_2", name: "Read", input: { path: "InvoiceReconciler.java" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: JAVA_FILE }] }],
    },
  ],
  stream: true,
};

// Sibling file for the project symbol index (written to the temp project root).
const SIBLING_CS = [
  "using System.Net.Http;",
  "namespace Voltra.Ledger",
  "{",
  "    public class LedgerClient",
  "    {",
  "        public LedgerClient(HttpClient http) {}",
  "        public void PostEntry(string id) {}",
  "    }",
  "}",
].join("\n");

const CSHARP_FILE = [
  "// Voltra billing — reconciliation service. Proprietary.",
  "using System;",
  "using System.Net.Http;",
  "using Voltra.Ledger;",
  "",
  "namespace Voltra.Billing",
  "{",
  "    public class InvoiceReconciler",
  "    {",
  "        private readonly LedgerClient _ledgerClient;",
  "        private readonly HttpClient _http = new HttpClient();",
  "",
  "        public InvoiceReconciler(LedgerClient ledgerClient)",
  "        {",
  "            _ledgerClient = ledgerClient;",
  "        }",
  "",
  "        public void Reconcile(string id) => _ledgerClient.PostEntry(id);",
  "    }",
  "}",
].join("\n");

const csharpFileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_3", name: "Read", input: { path: "Reconciler.cs" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_3", content: [{ type: "text", text: CSHARP_FILE }] }],
    },
  ],
  stream: true,
};

const KOTLIN_FILE = [
  "// Voltra billing — reconciliation service. Proprietary.",
  "package com.voltra.billing",
  "",
  "import org.slf4j.LoggerFactory",
  "import com.voltra.ledger.LedgerClient // ledger SDK",
  "",
  "class InvoiceReconciler(private val ledgerClient: LedgerClient) {",
  "    private val log = LoggerFactory.getLogger(InvoiceReconciler::class.java)",
  "",
  "    fun reconcile(ids: List<String>): Int {",
  "        ids.forEach { ledgerClient.postEntry(it) }",
  "        log.info(\"posted {} entries\", ids.size)",
  "        return ids.size",
  "    }",
  "}",
].join("\n");

const kotlinFileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the kotlin reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_4", name: "Read", input: { path: "InvoiceReconciler.kt" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_4", content: [{ type: "text", text: KOTLIN_FILE }] }],
    },
  ],
  stream: true,
};

const PY_FILE = [
  '"""Voltra billing — reconciliation service. Proprietary."""',
  "import logging",
  "",
  "import requests",
  "",
  "from voltra_billing.ledger import LedgerClient",
  "",
  "log = logging.getLogger(__name__)",
  "",
  "",
  "class InvoiceReconciler:",
  "    def __init__(self, ledger_client: LedgerClient):",
  "        self.ledger_client = ledger_client",
  "        self.session = requests.Session()",
  "",
  "    def reconcile(self, batch_ids):",
  "        # post each entry to the internal ledger",
  "        for batch_id in batch_ids:",
  "            self.ledger_client.post_entry(batch_id)",
  "        log.info('posted %d entries', len(batch_ids))",
  "        return len(batch_ids)",
].join("\n");

const pythonFileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the python reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_5", name: "Read", input: { path: "reconciler.py" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_5", content: [{ type: "text", text: PY_FILE }] }],
    },
  ],
  stream: true,
};

const COBOL_FILE = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. VBILLRECON.",
  "000300* VOLTRA BILLING RECONCILIATION. PROPRIETARY.",
  "000400 DATA DIVISION.",
  "000500 WORKING-STORAGE SECTION.",
  "000600 01  WS-MATCHED-CNT PIC 9(6) VALUE ZERO.",
  '000700 01  WS-KEY PIC X(20) VALUE "AKIA5XQ2WJ8NPLR3MKVT".',
  "000800 PROCEDURE DIVISION.",
  "000900 MAIN-PARA.",
  "001000     ADD 1 TO WS-MATCHED-CNT",
  '001100     DISPLAY "MATCHED: " WS-MATCHED-CNT',
  "001200     STOP RUN.",
].join("\n");

const cobolFileReadRequest = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  messages: [
    { role: "user", content: "read the cobol reconciler" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_6", name: "Read", input: { path: "VBILLRECON.cbl" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_6", content: [{ type: "text", text: COBOL_FILE }] }],
    },
  ],
  stream: true,
};

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

function startGateway(wylocPath, projectRoot) {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_CONFIG: wylocPath,
      WYLOC_PROJECT_ROOT: projectRoot,
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
      languages: ["go", "java", "csharp", "kotlin", "python", "cobol"],
      internalPackagePrefixes: {
        go: ["github.com/voltra/billing-core"],
        java: ["com.voltra."],
        csharp: ["Voltra."],
        kotlin: ["com.voltra."],
        python: ["voltra_billing"],
      },
      // TS/JS masking ON — scenario 3 proves Java still routes to poly.
      policy: { code: true },
    }),
  );
  // The temp dir doubles as the project root: the sibling .cs file feeds the
  // project symbol index, which must resolve LedgerClient as internal.
  writeFileSync(join(dir, "LedgerClient.cs"), SIBLING_CS);

  const upstream = await startUpstream();
  const gateway = startGateway(wylocPath, dir);

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

  console.error("\n── Poly-masking (Java): sniff precedence over TS/JS ─");
  captured = null;
  await post(javaFileReadRequest);
  assert(captured !== null, "[java] upstream received the request");
  // Assert on the tool_result TEXT: the tool_use ARGUMENTS ({path: "InvoiceReconciler.java"})
  // are structure and deliberately untouched.
  const javaText = JSON.parse(captured).messages[2].content[0].content[0].text;
  assert(!/\bInvoiceReconciler\b/.test(javaText), "[java] class 'InvoiceReconciler' masked out");
  assert(!captured.includes("com.voltra"), "[java] internal package paths masked out");
  assert(!captured.includes("Proprietary"), "[java] comment stripped");
  assert(captured.includes("import org.slf4j.Logger;"), "[java] slf4j import byte-intact (not TS-mangled)");
  assert(/\bLoggerFactory\b/.test(captured), "[java] external 'LoggerFactory' preserved");
  assert(captured.includes("package masked.mod_"), "[java] package declaration masked, Java syntax kept");
  assert(/\breconcile\b/.test(captured), "[java] method 'reconcile' untouched (members off)");

  console.error("\n── Poly-masking (C#): project index on file-read ────");
  captured = null;
  await post(csharpFileReadRequest);
  assert(captured !== null, "[csharp] upstream received the request");
  const csText = JSON.parse(captured).messages[2].content[0].content[0].text;
  assert(!/\bInvoiceReconciler\b/.test(csText), "[csharp] declared class masked out");
  assert(!csText.includes("Voltra"), "[csharp] internal namespaces + usings masked out");
  assert(!/\bLedgerClient\b/.test(csText), "[csharp] index-resolved 'LedgerClient' masked (the Phase-1 ambiguity)");
  assert(/\bHttpClient\b/.test(csText), "[csharp] external 'HttpClient' preserved");
  assert(csText.includes("using System.Net.Http;"), "[csharp] external using byte-intact");
  assert(!csText.includes("Proprietary"), "[csharp] comment stripped");
  assert(/\bPostEntry\b/.test(csText), "[csharp] member 'PostEntry' untouched (members off)");

  console.error("\n── Poly-masking (Kotlin): sniff (no semicolon) ──────");
  captured = null;
  await post(kotlinFileReadRequest);
  assert(captured !== null, "[kotlin] upstream received the request");
  const ktText = JSON.parse(captured).messages[2].content[0].content[0].text;
  assert(!/\bInvoiceReconciler\b/.test(ktText), "[kotlin] class masked out");
  assert(!ktText.includes("com.voltra"), "[kotlin] internal package + import masked out");
  assert(!ktText.includes("ledger SDK"), "[kotlin] trailing import comment stripped (grammar quirk)");
  assert(ktText.includes("import org.slf4j.LoggerFactory"), "[kotlin] external import byte-intact");
  assert(/\bforEach\b/.test(ktText) && /\bLoggerFactory\b/.test(ktText), "[kotlin] externals preserved");
  assert(/\breconcile\b/.test(ktText), "[kotlin] method untouched (members off)");

  console.error("\n── Poly-masking (Python): file-read path ────────────");
  captured = null;
  await post(pythonFileReadRequest);
  assert(captured !== null, "[python] upstream received the request");
  const pyText = JSON.parse(captured).messages[2].content[0].content[0].text;
  assert(!/\bInvoiceReconciler\b/.test(pyText), "[python] class masked out");
  assert(!pyText.includes("voltra_billing"), "[python] internal module path masked out");
  assert(!pyText.includes("Proprietary"), "[python] module docstring stripped");
  assert(!pyText.includes("post each entry"), "[python] # comment stripped");
  assert(pyText.includes("import logging") && /\brequests\b/.test(pyText), "[python] stdlib + pip preserved");
  assert(/\bledger_client\b/.test(pyText) && /\breconcile\b/.test(pyText), "[python] attributes/methods untouched (dynamic typing)");

  console.error("\n── Poly-masking (COBOL): fixed format + re-exec ─────");
  // The gateway (spawned under the dev Node via tsx) must have re-exec'd
  // itself with --liftoff-only because cobol is enabled — a crash here would
  // mean the V8 OOM guard failed.
  captured = null;
  await post(cobolFileReadRequest);
  assert(captured !== null, "[cobol] upstream received the request (gateway survived, re-exec OK)");
  const cblText = JSON.parse(captured).messages[2].content[0].content[0].text;
  assert(!/\bVBILLRECON\b/.test(cblText), "[cobol] PROGRAM-ID masked out");
  assert(!/(?<![A-Z0-9-])WS-MATCHED-CNT(?![A-Z0-9-])/.test(cblText), "[cobol] data item masked out");
  assert(!cblText.includes("PROPRIETARY"), "[cobol] comment line stripped");
  assert(!cblText.includes("AKIA5XQ2WJ8NPLR3MKVT"), "[cobol] AWS key swapped");
  assert(/\bPERFORM\b|\bDISPLAY\b/.test(cblText) && /\bADD\b/.test(cblText), "[cobol] verbs untouched");
  const cblLines = cblText.split("\n");
  assert(cblLines.every((l) => l.includes("WYLOC_MOCK_") || l.length <= 72), "[cobol] column alignment: no identifier line crosses col 72");

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
