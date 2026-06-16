/**
 * wyloc.json end-to-end gateway test. No real API key.
 *
 * A) A valid wyloc.json with a custom "Employee ID" pattern: a request carrying
 *    EMP-778899 is masked to WYLOC_MOCK_EMPLOYEE_ID_… before forwarding, and the
 *    mock echoed back by the fake upstream rehydrates to the real value.
 * B) An INVALID wyloc.json: the gateway refuses to start (non-zero exit, clear
 *    error, never binds the port).
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const UPSTREAM_PORT = 9981;
const GATEWAY_PORT = 9982;
const dir = mkdtempSync(join(tmpdir(), "wyloc-gw-"));

let captured = null;
function ev(e, d) { return `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`; }
function echo(token) {
  const ps = ["Rotated ", token.slice(0, 10), token.slice(10), " ok."];
  let o = ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "x", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  o += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const p of ps) o += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } });
  o += ev("content_block_stop", { type: "content_block_stop", index: 0 });
  o += ev("message_stop", { type: "message_stop" });
  return o;
}
function startUpstream() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const ch = []; req.on("data", (c) => ch.push(c));
      req.on("end", async () => {
        captured = Buffer.concat(ch).toString("utf8");
        const m = captured.match(/WYLOC_MOCK_EMPLOYEE_ID_[A-Z0-9]+/);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (m) { const b = Buffer.from(echo(m[0]), "utf8"); for (let i = 0; i < b.length; i += 9) { res.write(b.subarray(i, i + 9)); await sleep(1); } res.end(); }
        else res.end("event: message_stop\ndata: {}\n\n");
      });
    });
    s.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(s));
  });
}
function startGateway(configPath, port) {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, WYLOC_GATEWAY_PORT: String(port), WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`, WYLOC_CONFIG: configPath, WYLOC_VERBOSE: "true" },
    stdio: ["ignore", "inherit", "pipe"],
  });
}
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail = "") { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}${detail ? " — " + detail : ""}`); } }
function parseSse(body) {
  return body.split("\n\n").filter((b) => b.trim()).map((blk) => {
    const lines = blk.split("\n");
    const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    let d = null; try { d = JSON.parse(data); } catch {}
    return { event, data: d };
  });
}

async function main() {
  const upstream = await startUpstream();

  // ── A. Valid config: custom pattern masked + rehydrated ───────────────
  console.error("\n── A. valid wyloc.json: custom pattern e2e ───────");
  const validPath = join(dir, "wyloc.json");
  writeFileSync(validPath, JSON.stringify({
    version: 1,
    patterns: [{ name: "Employee ID", match: { type: "prefix", prefix: "EMP-", format: { kind: "digits", length: 6 } }, examples: { match: ["EMP-123456"] } }],
  }));
  const gw = startGateway(validPath, GATEWAY_PORT);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break; } catch {} await sleep(100); }

  const bodyA = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "x", max_tokens: 32, stream: true, messages: [{ role: "user", content: "please rotate EMP-778899 now" }] }),
  })).text();

  ok("upstream received request", captured !== null);
  ok("employee id masked out of request", captured && !captured.includes("EMP-778899"));
  ok("mock present in request", captured && /WYLOC_MOCK_EMPLOYEE_ID_/.test(captured));
  const text = parseSse(bodyA).filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
  ok("response rehydrated to real employee id", text === "Rotated EMP-778899 ok.", JSON.stringify(text));
  gw.kill("SIGTERM");
  await sleep(200);

  // ── B. Invalid config: gateway refuses to start ───────────────────────
  console.error("\n── B. invalid wyloc.json: fail-closed startup ────");
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, JSON.stringify({ version: 1, patturns: [] })); // typo
  const bad = startGateway(badPath, GATEWAY_PORT + 1);
  let stderr = "";
  bad.stderr.on("data", (d) => { stderr += d.toString(); });
  const exitCode = await new Promise((res) => bad.on("exit", (code) => res(code)));
  ok("gateway exited non-zero on invalid config", exitCode !== 0, `exit=${exitCode}`);
  ok("error names the file and is specific", /wyloc\.json is invalid/.test(stderr) && /did you mean/.test(stderr), stderr.slice(0, 300));
  let bound = false;
  try { await fetch(`http://127.0.0.1:${GATEWAY_PORT + 1}/healthz`); bound = true; } catch {}
  ok("gateway never bound the port", !bound);

  upstream.close();
  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ wyloc.json gateway test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
