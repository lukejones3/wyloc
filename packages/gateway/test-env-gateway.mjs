/**
 * .env masking integration test — file-read path across all three adapters,
 * the typed/pasted message path, the over-mask guard, and detector fallback.
 * No real API key. maskEnv + maskFileReads default on; maskCode left OFF so the
 * over-mask guard isolates env behavior.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UP = 9980, GW = 9981;
const ENV = "DATABASE_URL=postgres://admin:s3cr3t@db/app\nAPI_KEY=sk_live_xyz789\nADMIN_CODE=4815";
const SECRET = "AKIA5XQ2WJ8NPLR3MKVT";
let captured = null;

function startUpstream() {
  return new Promise((resolve) => {
    const s = createServer((rq, rs) => {
      const c = []; rq.on("data", (x) => c.push(x));
      rq.on("end", () => { captured = Buffer.concat(c).toString("utf8"); rs.writeHead(200, { "content-type": "text/event-stream" }); rs.end("event: message_stop\ndata: {}\n\n"); });
    });
    s.listen(UP, "127.0.0.1", () => resolve(s));
  });
}
function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, WYLOC_GATEWAY_PORT: String(GW), WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP}`, WYLOC_OPENAI_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP}`, WYLOC_VERBOSE: "false" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };
async function send(path, obj) {
  const h = path.includes("messages")
    ? { "content-type": "application/json", "x-api-key": "sk-ant-FAKE", "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", "authorization": "Bearer sk-FAKE" };
  await fetch(`http://127.0.0.1:${GW}${path}`, { method: "POST", headers: h, body: JSON.stringify(obj) }).catch(() => {});
  await sleep(250);
}
const envMasked = () => captured && !captured.includes("s3cr3t") && !captured.includes("sk_live_xyz789") && !captured.includes("4815") && captured.includes("DATABASE_URL") && captured.includes("API_KEY") && captured.includes("WYLOC_MOCK_ENV_");

async function main() {
  const up = await startUpstream();
  const gw = startGateway();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) break; } catch {} await sleep(100); }

  // file-read path, all three adapters
  await send("/v1/messages", { model: "x", max_tokens: 8, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read_file", input: { file_path: ".env" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: ENV }] }] });
  ok("Anthropic tool_result .env: values masked, keys+structure kept", envMasked(), captured?.slice(0, 160));

  await send("/v1/chat/completions", { model: "gpt-4o", messages: [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: ENV }] });
  ok("OpenAI-Chat role:tool .env: values masked", envMasked(), captured?.slice(0, 160));

  await send("/v1/responses", { model: "gpt-5-codex", input: [
    { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: ENV }] });
  ok("OpenAI-Responses function_call_output .env: values masked (Codex)", envMasked(), captured?.slice(0, 160));

  // message path (typed/pasted .env in a user message)
  await send("/v1/messages", { model: "x", max_tokens: 8, messages: [{ role: "user", content: ENV }] });
  ok("Anthropic message pasted .env: values masked", envMasked(), captured?.slice(0, 160));

  // over-mask guard: a code block is NOT treated as env
  await send("/v1/messages", { model: "x", max_tokens: 8, messages: [{ role: "user", content: "const a = 1\nconst b = 2\nfunction f() { return a + b }" }] });
  ok("code block NOT env-masked (no over-mask)", captured && !captured.includes("WYLOC_MOCK_ENV_") && captured.includes("const a"), captured?.slice(0, 160));

  // detector fallback: a recognized secret in plain (non-env) tool_result still masked
  await send("/v1/messages", { model: "x", max_tokens: 8, messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `log line: key ${SECRET} seen once` }] }] });
  ok("non-env recognized secret still masked (detector fallback intact)", captured && !captured.includes(SECRET) && captured.includes("WYLOC_MOCK_"), captured?.slice(0, 160));

  gw.kill("SIGTERM"); up.close();
  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ env-mask gateway test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
