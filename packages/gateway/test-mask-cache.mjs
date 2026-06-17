/**
 * Masking content-cache tests (perf + correctness invariant).
 * Run with: node --import tsx test-mask-cache.mjs
 *
 * The guardrail: a cached result must be BYTE-IDENTICAL to a fresh result
 * (caching changes cost only, never output). Also proves resent history is a
 * cache hit so per-turn work is proportional to NEW content.
 */
import { runDetectorSwap } from "./src/swap-request.ts";
import { MaskCache } from "./src/mask-cache.ts";
import { SessionStore } from "./src/session.ts";
import { CodeMaskHandle } from "./src/code-mask.ts";
import { loadConfig } from "./src/config.ts";
import { Logger } from "./src/logger.ts";
import { AnthropicAdapter } from "./src/adapters/anthropic.ts";

const cfg = { ...loadConfig(), verbose: false, maskCode: true };
const log = Logger.from(cfg);
const adapter = new AnthropicAdapter("https://api.anthropic.com");
const SALT = "fixed-test-salt";
const K1 = "AKIA5XQ2WJ8NPLR3MKVT";
const K2 = "AKIA7YH2QW9MZ4XK8NPL";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };
const body = (o) => Buffer.from(JSON.stringify(o));

async function main() {
  // ── MaskCache primitive ──
  {
    const c = new MaskCache(); let calls = 0;
    const a = c.memo("x", () => { calls++; return "A"; });
    const b = c.memo("x", () => { calls++; return "B"; });
    ok("memo: 2nd same-key call returns cached, compute ran once", a === "A" && b === "A" && calls === 1);
    ok("memo: stats (1 hit, 1 miss)", c.stats().hits === 1 && c.stats().misses === 1);
    c.memo("y", () => "Y");
    ok("memo: different key misses", c.stats().misses === 2 && c.stats().size === 2);
  }

  // ── Detector swap: resend is a hit; cached === fresh (byte-identical) ──
  {
    const b = body({ model: "x", messages: [{ role: "user", content: `my key ${K1} ok` }] });
    const store = new SessionStore(SALT);
    const cache = new MaskCache();
    const o1 = await runDetectorSwap(adapter, b, cfg, store, cache);
    const o2 = await runDetectorSwap(adapter, b, cfg, store, cache); // warm
    ok("detector: secret masked", !o1.body.toString().includes(K1));
    ok("detector: resend byte-identical", o1.body.equals(o2.body));
    ok("detector: cache hit on resend", cache.stats().hits > 0);

    // Fresh path: new cache + new store with the SAME salt → must equal warm.
    const oFresh = await runDetectorSwap(adapter, b, cfg, new SessionStore(SALT), new MaskCache());
    ok("detector: cached === fresh (byte-identical)", o1.body.equals(oFresh.body));
  }

  // ── Code mask: resend is a hit; cached === fresh ──
  {
    const b = body({ messages: [{ role: "user", content: "look:\n```ts\nexport class SecretEngine {}\n```" }] });
    const store = new SessionStore(SALT);
    const code = new CodeMaskHandle(cfg, store, log);
    const r1 = await code.maskBody(adapter, b, store);
    const r2 = await code.maskBody(adapter, b, store); // warm
    ok("code: identifier masked", !r1.body.toString().includes("SecretEngine"));
    ok("code: resend byte-identical", r1.body.equals(r2.body));
    ok("code: cache hit on resend", code.cache.stats().hits > 0);

    const codeFresh = new CodeMaskHandle(cfg, new SessionStore(SALT), log);
    const rFresh = await codeFresh.maskBody(adapter, b, new SessionStore(SALT));
    ok("code: cached === fresh (byte-identical)", r1.body.equals(rFresh.body));
  }

  // ── Growing history: turn 2 = turn 1 + new content → turn 1 strings are HITS ──
  {
    const store = new SessionStore(SALT);
    const cache = new MaskCache();
    const msg1 = `secret ${K1} one`;
    const msg2 = `secret ${K2} two`;
    await runDetectorSwap(adapter, body({ messages: [{ role: "user", content: msg1 }] }), cfg, store, cache);
    const hitsBefore = cache.stats().hits;
    const missBefore = cache.stats().misses;
    const o = await runDetectorSwap(adapter, body({ messages: [{ role: "user", content: msg1 }, { role: "user", content: msg2 }] }), cfg, store, cache);
    ok("growing history: resent msg1 was a cache hit", cache.stats().hits === hitsBefore + 1);
    ok("growing history: new msg2 was a miss (real work only on new)", cache.stats().misses === missBefore + 1);
    ok("growing history: both secrets masked", !o.body.toString().includes(K1) && !o.body.toString().includes(K2));
  }

  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ mask-cache test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
