/**
 * Regression: masking must be IDEMPOTENT — the detector must never re-mask an
 * existing WYLOC_MOCK_ placeholder. A structural pass (env/SQL/code) can swap a
 * value to a mock, and the detector then runs on that same text; if it re-matched
 * the placeholder (e.g. as an .env assignment value) it would chain mock→mock,
 * which a single rehydration pass cannot reverse (surfaced by a live Gemini CLI
 * file-read smoke test). Run with: node --import tsx test-no-remask.mjs
 */
import { applyDetectorSwap } from "./src/swap-request.ts";
import { MaskCache } from "./src/mask-cache.ts";
import { SessionStore } from "./src/session.ts";
import { FileReadMaskHandle } from "./src/mask-file-reads.ts";
import { CodeMaskHandle } from "./src/code-mask.ts";
import { loadConfig } from "./src/config.ts";
import { Logger } from "./src/logger.ts";
import { AnthropicAdapter } from "./src/adapters/anthropic.ts";

const cfg = { ...loadConfig(), verbose: false, maskSql: false, maskCode: true, maskEnv: true, maskFileReads: true, injectSystemPrompt: true };
const log = Logger.from(cfg);
const adapter = new AnthropicAdapter("x");

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

async function main() {
  // 1. Message text that ALREADY contains a placeholder → detector leaves it alone.
  {
    const store = new SessionStore("salt-a");
    const body = { model: "x", messages: [{ role: "user", content: "my token is WYLOC_MOCK_ENV_ABC123 keep it" }] };
    const det = await applyDetectorSwap(adapter, body, cfg, store, new MaskCache());
    ok("existing placeholder is not re-detected", det.detected === 0, `detected=${det.detected}`);
    ok("existing placeholder text unchanged", body.messages[0].content.includes("WYLOC_MOCK_ENV_ABC123"));
    ok("no mock-of-a-mock added to store", store.all().every((m) => !m.real.includes("WYLOC_MOCK_")));
  }

  // 2. File-read env file: env-mask + detector together must NOT chain.
  {
    const store = new SessionStore("salt-b");
    const fr = new FileReadMaskHandle(cfg, null, new CodeMaskHandle(cfg, store, log), log);
    const envFile = "DATABASE_URL=postgres://admin:p4ssw0rd@db/prod\nAWS_SECRET=AKIA5XQ2WJ8NPLR3MKVT\n";
    const body = { model: "x", messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: ".env" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: envFile }] },
    ] };
    const res = await fr.applyToParsed(adapter, body, store);
    const masked = body.messages[1].content[0].content;

    ok("file-read: real secret swapped", !masked.includes("AKIA5XQ2WJ8NPLR3MKVT") && !masked.includes("p4ssw0rd"));
    ok("file-read: produced mocks", res.hasSecretMock && masked.includes("WYLOC_MOCK_"));
    // The crux: every stored mapping's REAL value is an actual value, never a mock.
    ok("file-read: NO mock-of-a-mock in store", store.all().every((m) => !m.real.includes("WYLOC_MOCK_")),
      store.all().map((m) => `${m.mock}=>${m.real.slice(0, 16)}`).join(" | "));
    // And the masked text carries no double-prefixed placeholder.
    ok("file-read: no WYLOC_MOCK_…_ASSIGNMENT chain placeholder forwarded", !/WYLOC_MOCK_ENV_ASSIGNMENT/.test(masked), masked);
  }

  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ no-remask (idempotent masking) test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
