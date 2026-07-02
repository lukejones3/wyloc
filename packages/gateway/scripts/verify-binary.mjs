#!/usr/bin/env node
/**
 * THE load-bearing verification: prove the standalone distribution works on a
 * CLEAN machine with no system Python / Node, on the platform it's run on.
 *
 *   node scripts/verify-binary.mjs [--platform <key>] [--dist <dir>]
 *
 * Spawns the built `wyloc` binary with a STRIPPED environment (the cross-platform
 * equivalent of `env -i`: no PATH entry that could reach a system python/node),
 * pointed at a fake upstream, and asserts the binary:
 *   1. boots and serves /healthz,
 *   2. masks an AWS-shaped secret  → WYLOC_MOCK_…           (detector, pure JS)
 *   3. masks a SQL table name      → bundled Python+sqlglot  (the SQL differentiator)
 *   4. masks a raw-regex pattern   → bundled RE2             (loads at all = works, else fail-closed)
 *   5. masks Go + COBOL code       → bundled runtime/wasm grammars (poly-masker;
 *      COBOL also proves the SEA path needs NO --liftoff-only re-exec: the
 *      pinned Node 22 is unaffected by the V8 tier-up OOM, and isSea() must
 *      suppress the re-exec — a hang or crash here would catch a misfire)
 *
 * Exit non-zero (loudly) if ANY of these fail — that is the per-platform proof
 * that the differentiator ships working with zero machine prerequisites. It is
 * NEVER skipped; a platform that can't pass this is a platform that doesn't ship.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const GATEWAY = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
function hostPlatform() {
  const a = process.arch === "arm64" ? "arm64" : "x64";
  const o = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux";
  return `${o}-${a}`;
}
const platform = valueOf("--platform") ?? hostPlatform();
const isWin = platform.startsWith("win");
const dist = resolve(valueOf("--dist") ?? join(GATEWAY, "dist-bin", platform));
const binary = join(dist, `wyloc${isWin ? ".exe" : ""}`);

const SECRET = "AKIA5XQ2WJ8NPLR3MKVT";
const TABLE = "secret_ledger";
const TICKET = "TKT-1234";
const UP_PORT = 9700;
const GW_PORT = 9701;

// The nine grammar wasm files that MUST ship next to the binary (the fix for
// the silent-grammar-degradation bug — verified per platform below).
const POLY_GRAMMARS = [
  "tree-sitter-go.wasm", "tree-sitter-java.wasm", "tree-sitter-c_sharp.wasm",
  "tree-sitter-kotlin.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm",
  "tree-sitter-c.wasm", "tree-sitter-cpp.wasm", "tree-sitter-COBOL.wasm",
];

// One fenced block per language, each DECLARING an internal identifier that
// must be masked (declaration is internal by definition — no prefix needed, so
// this proves grammar load+mask independent of internalPackagePrefixes).
const POLY_SNIPPETS = {
  go: "package billing\nfunc GoReconcile() {}\n",
  java: "public class JavaReconciler {}\n",
  cs: "class CsReconciler {}\n",
  kotlin: "class KtReconciler\n",
  python: "class PyReconciler:\n    pass\n",
  rust: "pub struct RsReconciler;\n",
  c: "struct c_reconciler { int x; };\n",
  cpp: "class CppReconciler {};\n",
  cobol: "000100 IDENTIFICATION DIVISION.\n000200 PROGRAM-ID. COBOLPROG.\n000300 PROCEDURE DIVISION.\n000400 MAIN-PARA.\n000500     STOP RUN.\n",
};

// The internal identifier each snippet should mask OUT of the forwarded body.
const POLY_MARKERS = {
  go: "GoReconcile", java: "JavaReconciler", csharp: "CsReconciler",
  kotlin: "KtReconciler", python: "PyReconciler", rust: "RsReconciler",
  c: "c_reconciler", cpp: "CppReconciler", cobol: "COBOLPROG",
};

let passed = 0, failed = 0;
const ok = (n, c, d = "") => { if (c) { passed++; console.error(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}${d ? " — " + d : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-platform "clean environment": no PATH that reaches a system python/node.
 * Unix → empty PATH (binary + bundled python are invoked by absolute path).
 * Windows → only System32 (needed for process/DLL creation) which has no python.
 */
function cleanEnv(extra) {
  const base = isWin
    ? {
        SystemRoot: process.env.SystemRoot || "C:\\Windows",
        windir: process.env.windir || "C:\\Windows",
        TEMP: process.env.TEMP || process.env.TMP || tmpdir(),
        TMP: process.env.TMP || process.env.TEMP || tmpdir(),
        USERPROFILE: process.env.USERPROFILE || "",
        PATH: `${process.env.SystemRoot || "C:\\Windows"}\\System32`,
      }
    : { HOME: process.env.HOME || tmpdir(), PATH: "" };
  return { ...base, ...extra };
}

async function main() {
  if (!existsSync(binary)) { console.error(`\n✗ binary not found: ${binary}\n`); process.exit(1); }
  console.error(`\n── clean-machine verification: ${platform} ──`);
  console.error(`  binary: ${binary}`);

  // Raw-regex config — if bundled RE2 is missing this fails-closed at startup,
  // so the binary booting at all is the first half of the RE2 proof.
  const cfg = join(tmpdir(), "wyloc-verify.json");
  writeFileSync(cfg, JSON.stringify({
    version: 1,
    patterns: [{ name: "Ticket", match: { type: "regex", advanced: true, source: "TKT-\\d{4}" }, examples: { match: ["TKT-1234"] } }],
    // "all" enables every poly language INCLUDING COBOL (opt-in) — the binary
    // must ship + load all nine grammars and mask them on THIS platform.
    languages: ["all"],
    internalPackagePrefixes: { go: ["github.com/voltra/billing-core"] },
  }));

  // Fake upstream (runs under the runner's Node; the BINARY is what's clean).
  let captured = null;
  const upstream = createServer((req, res) => {
    const c = []; req.on("data", (x) => c.push(x));
    req.on("end", () => { captured = Buffer.concat(c).toString("utf8"); res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: message_stop\ndata: {}\n\n"); });
  });
  await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

  // Spawn the binary CLEAN.
  let stderr = "";
  const gw = spawn(binary, ["start"], {
    env: cleanEnv({
      WYLOC_GATEWAY_PORT: String(GW_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      WYLOC_MASK_SQL: "true",
      WYLOC_CONFIG: cfg,
      WYLOC_VERBOSE: "true",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout.on("data", (d) => { stderr += d.toString(); });
  gw.stderr.on("data", (d) => { stderr += d.toString(); });
  gw.on("exit", (code) => { if (code && captured === null) console.error(`  (binary exited early code=${code})\n${stderr}`); });

  // 1. boots + serves /healthz
  let up = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${GW_PORT}/healthz`)).ok) { up = true; break; } } catch {} await sleep(100); }
  ok("boots and serves /healthz", up, stderr.slice(-400));

  // SQL worker readiness (bundled Python) — wait for the ready log.
  let sqlReady = false;
  for (let i = 0; i < 60; i++) { if (/sqlglot worker ready/.test(stderr)) { sqlReady = true; break; } await sleep(200); }
  ok("bundled Python+sqlglot worker ready (no system Python)", sqlReady, lastLines(stderr));

  // RE2 config loaded (else the binary would have fail-closed at startup)
  ok("raw-regex config loaded (bundled RE2 active)", /custom pattern/.test(stderr), lastLines(stderr));

  if (up) {
    await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-FAKE", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "x", max_tokens: 16, messages: [{ role: "user", content: `key ${SECRET}\n\`\`\`sql\nSELECT id FROM ${TABLE}\n\`\`\`\nref ${TICKET}` }] }),
    }).catch(() => {});
    await sleep(800);
  }

  ok("upstream received the (masked) request", captured !== null);
  ok("AWS secret masked (detector, pure JS)", captured !== null && !captured.includes(SECRET));
  ok("SQL table masked (bundled Python+sqlglot)", captured !== null && !captured.includes(TABLE), "SQL masking did NOT work out-of-box");
  ok("raw-regex pattern masked (bundled RE2)", captured !== null && !captured.includes(TICKET), "RE2 raw-regex did NOT work out-of-box");
  ok("mock placeholders present", captured !== null && captured.includes("WYLOC_MOCK_"));

  // ── 5. Poly grammars: SHIP + LOAD + MASK on this platform ────────────────────
  // This is the cross-platform guard for the silent-grammar-degradation bug
  // (found + fixed on darwin-arm64): "grammars don't load on Windows",
  // "re-exec misbehaves on Linux". Fails loudly per platform.

  // 5a. All nine grammar wasm files + the web-tree-sitter core ship next to the
  //     binary (the fix that keeps poly masking from silently degrading to
  //     detector-only in the SEA build).
  const wasmDir = join(dist, "runtime", "wasm");
  for (const g of POLY_GRAMMARS) {
    ok(`grammar ships: ${g}`, existsSync(join(wasmDir, g)), `missing ${join(wasmDir, g)}`);
  }
  ok("web-tree-sitter core wasm ships", existsSync(join(wasmDir, "tree-sitter.wasm")));

  // 5b. The COBOL re-exec guard did NOT misfire inside the SEA binary (pinned
  //     Node 22 is safe; isSea() must suppress the --liftoff-only re-exec).
  ok("re-exec correctly suppressed inside SEA", !/re-executing with --liftoff-only/.test(stderr), lastLines(stderr));

  // 5c. All nine grammars LOAD + MASK: one request with a fenced block per
  //     language, each declaring an internal identifier that must be masked
  //     out. Proves every grammar loads from the bundled wasm on this OS — not
  //     just that the files are present. (Declared identifiers mask without
  //     needing internalPackagePrefixes, so this is prefix-independent.)
  if (up) {
    captured = null;
    let content = "review these:\n";
    for (const [tag, snippet] of Object.entries(POLY_SNIPPETS)) {
      content += "```" + tag + "\n" + snippet + "\n```\n";
    }
    await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-FAKE", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "x", max_tokens: 16, messages: [{ role: "user", content }] }),
    }).catch(() => {});
    await sleep(2000);
  }
  ok("upstream received the multi-language request", captured !== null, lastLines(stderr));
  for (const [lang, marker] of Object.entries(POLY_MARKERS)) {
    const masked = captured !== null && !new RegExp(`\\b${marker}\\b`).test(captured);
    ok(`${lang} masked from bundled wasm (grammar loads on ${platform})`, masked,
      captured === null ? "no request captured" : `"${marker}" survived — grammar likely degraded to detector-only`);
  }

  // 5d. The FILE-READ / content-router path also works from the binary (a Go
  //     file the agent "read", sent as a tool_result — not fenced).
  if (up) {
    captured = null;
    const GO_FILE = "package billing\n\nimport \"fmt\"\n\nfunc FileReadReconcile() {\n\tfmt.Println(\"x\")\n}\n";
    await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-FAKE", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "x", max_tokens: 16, messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_v", name: "Read", input: { path: "r.go" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_v", content: [{ type: "text", text: GO_FILE }] }] },
      ] }),
    }).catch(() => {});
    await sleep(1200);
  }
  ok("file-read content-router masks poly code from the binary", captured !== null && !/\bFileReadReconcile\b/.test(captured) && captured.includes("fmt"), lastLines(stderr));

  gw.kill("SIGTERM"); upstream.close();
  await sleep(200);

  console.error(`\n${failed === 0 ? "✓" : "✗"} ${platform}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function lastLines(s, n = 6) { return s.trim().split("\n").slice(-n).join("\n"); }
main().catch((e) => { console.error("verify error", e); process.exit(1); });
