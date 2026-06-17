/**
 * parse-once correctness gate: the single-parse/single-serialize pipeline must
 * produce BYTE-IDENTICAL output to the old per-pass Buffer→Buffer roundtrip.
 * Run with: node --import tsx test-parse-once.mjs
 *
 * (SQL is excluded here to avoid the python worker; its applyToParsed is the
 * same shape as code's, and the SQL integration test exercises it end-to-end
 * through the new proxy.)
 */
import { runDetectorSwap, applyDetectorSwap } from "./src/swap-request.ts";
import { MaskCache } from "./src/mask-cache.ts";
import { SessionStore } from "./src/session.ts";
import { CodeMaskHandle } from "./src/code-mask.ts";
import { EnvMaskHandle } from "./src/env-mask.ts";
import { FileReadMaskHandle } from "./src/mask-file-reads.ts";
import { loadConfig } from "./src/config.ts";
import { Logger } from "./src/logger.ts";
import { AnthropicAdapter } from "./src/adapters/anthropic.ts";

const cfg = { ...loadConfig(), verbose: false, maskSql: false, maskCode: true, maskEnv: true, maskFileReads: true, injectSystemPrompt: true };
const log = Logger.from(cfg);
const adapter = new AnthropicAdapter("x");
const SALT = "parse-once-salt";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

function handles() {
  const store = new SessionStore(SALT);
  return { store, code: new CodeMaskHandle(cfg, store, log), env: new EnvMaskHandle(cfg, log),
    fr: new FileReadMaskHandle(cfg, null, new CodeMaskHandle(cfg, store, log), log), cache: new MaskCache() };
}

// OLD: each pass parses+serializes its own Buffer; injection split as before.
async function oldPipeline(h, body) {
  let b = (await h.code.maskBody(adapter, body, h.store)).body;
  b = (await h.env.maskBody(adapter, b, h.store)).body;
  const fr = await h.fr.maskBody(adapter, b, h.store); b = fr.body;
  const outcome = await runDetectorSwap(adapter, b, cfg, h.store, h.cache);
  b = outcome.body;
  if (fr.hasSecretMock && !outcome.injected && cfg.injectSystemPrompt) {
    const p = JSON.parse(b.toString("utf8")); adapter.injectDirective(p); b = Buffer.from(JSON.stringify(p), "utf8");
  }
  return b;
}

// NEW: parse once, apply all passes in place, inject once, serialize once.
async function newPipeline(h, body) {
  if (body.length === 0) return body;
  let parsed; try { parsed = JSON.parse(body.toString("utf8")); } catch { return body; }
  if (parsed === null || typeof parsed !== "object") return body;
  let mutated = false;
  if ((await h.code.applyToParsed(adapter, parsed, h.store)).blocks > 0) mutated = true;
  if ((await h.env.applyToParsed(adapter, parsed, h.store)).blocks > 0) mutated = true;
  const frr = await h.fr.applyToParsed(adapter, parsed, h.store);
  if (frr.files > 0) mutated = true;
  const det = await applyDetectorSwap(adapter, parsed, cfg, h.store, h.cache);
  if (det.detected > 0) mutated = true;
  let injected = false;
  if ((det.detected > 0 || frr.hasSecretMock) && cfg.injectSystemPrompt) { adapter.injectDirective(parsed); injected = true; mutated = true; }
  return mutated ? Buffer.from(JSON.stringify(parsed), "utf8") : body;
}

async function compare(name, obj) {
  const body = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  const oldB = await oldPipeline(handles(), body);
  const newB = await newPipeline(handles(), body);
  ok(`${name}: parse-once === multi-roundtrip (byte-identical)`, oldB.equals(newB),
    `\n   old: ${oldB.toString("utf8").slice(0, 120)}\n   new: ${newB.toString("utf8").slice(0, 120)}`);
}

async function main() {
  const FENCE = "```";
  // Multi-pass: secret (system), code fence, env tool-result, plain message.
  await compare("multi-pass request", {
    model: "x", max_tokens: 8,
    system: "deploy key AKIA5XQ2WJ8NPLR3MKVT keep safe",
    messages: [
      { role: "user", content: `optimize\n${FENCE}ts\nexport class SecretEngine {}\n${FENCE}\nthanks` },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: ".env" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "DATABASE_URL=postgres://a:s3cr3t@c/d\nLOG_LEVEL=info" }] },
      { role: "user", content: "a plain message with no sensitive content" },
    ],
  });

  // No-mask request: must forward the ORIGINAL bytes (both pipelines).
  await compare("no-mask request (forwards original bytes)", {
    model: "x", messages: [{ role: "user", content: "just a normal question about widgets" }],
  });

  // Secret-only (detector) request.
  await compare("secret-only request", {
    model: "x", messages: [{ role: "user", content: "my key is AKIA5XQ2WJ8NPLR3MKVT thanks" }],
  });

  // Non-JSON body → both passthrough.
  await compare("non-JSON body (passthrough)", "this is not json at all");

  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ parse-once test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
