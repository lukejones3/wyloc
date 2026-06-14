/**
 * wyloc.json config layer unit tests.
 * Run with: node --import tsx test-wyloc-config.mjs
 *
 * Covers: valid config loads + compiles; each constrained type compiles &
 * matches; custom patterns flow through detector scan→buildSwap→rehydrate;
 * invalid configs FAIL-CLOSED with specific errors; a dangerous raw regex is
 * rejected (ReDoS); raw regex without RE2 is fail-closed; internal scopes reach
 * the code masker; precedence (config > env).
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadWylocConfig, WylocConfigError } from "./src/wyloc/load.ts";
import { findReDoSRisk } from "./src/wyloc/redos.ts";
import { compilePattern } from "./src/wyloc/compile.ts";
import { applyWyloc } from "./src/wyloc/apply.ts";
import { loadConfig } from "./src/config.ts";
import { scan, buildSwap, rehydrate } from "@wyloc/detector";
import { CodeMasker, resolveConfig as resolveCodeCfg } from "@wyloc/code-masker";

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = "") { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}${detail ? " — " + detail : ""}`); } }

const dir = mkdtempSync(join(tmpdir(), "wyloc-"));
let n = 0;
/** Write a temp wyloc.json and return its path. */
function cfgFile(obj) { const p = join(dir, `c${n++}.json`); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; }
/** Load; return {loaded, err}. */
function tryLoad(obj) { try { return { loaded: loadWylocConfig(cfgFile(obj)) }; } catch (e) { return { err: e }; } }

// ── 1. A full valid config loads and compiles ──────────────────────────
console.error("\n── valid config ──────────────────────────────────");
const VALID = {
  version: 1,
  patterns: [
    { name: "Employee ID", match: { type: "prefix", prefix: "EMP-", format: { kind: "digits", length: 6 } },
      examples: { match: ["EMP-123456"], noMatch: ["EMP-12"] } },
    { name: "Account number", match: { type: "context", keywords: ["account", "acct"], value: { kind: "digits", length: 8 }, window: 16 },
      examples: { match: ["account 80042217"], noMatch: ["80042217 sold"] } },
    { name: "Project codename", match: { type: "list", terms: ["Project Stargate", "Falcon-9X"], caseInsensitive: true, wholeWord: true },
      examples: { match: ["the Falcon-9X rollout"] } },
    { name: "Customer IBAN", match: { type: "known", format: "iban" }, examples: { match: ["GB82WEST12345698765432"] } },
  ],
  internalScopes: ["@acme/*"],
  internalDomains: ["acme.com"],
  internalHosts: ["jenkins.acme.io"],
  blocklist: ["Atlas Initiative"],
  policy: { sql: true, code: true, pii: { ssn: false } },
  logging: { default: "aggregate", categories: { custom: "per_incident" } },
};
{
  const { loaded, err } = tryLoad(VALID);
  ok("valid config loads without throwing", !err, err && String(err.problems));
  if (loaded) {
    ok("4 custom + host + blocklist patterns compiled", loaded.customPatterns.length === 6, `${loaded.customPatterns.length}`);
    ok("internalScopes captured + glob normalized", loaded.internalScopes.includes("@acme/"));
    ok("internalDomains include host", loaded.internalDomains.includes("jenkins.acme.io"));
    ok("blocklist substrings captured", loaded.blocklistSubstrings.includes("Atlas Initiative"));
    ok("ssn PII off -> rules suppressed", loaded.suppressedRuleIds.includes("pii.ssn_dashed"));
    ok("policy.sql captured", loaded.policy.sql === true);
  }
}

// ── 2. Each constrained type compiles & matches its example ────────────
console.error("\n── constrained types compile & match ─────────────");
for (const [label, pat] of [
  ["prefix", { name: "X", match: { type: "prefix", prefix: "EMP-", format: { kind: "digits", length: 6 } }, examples: { match: ["EMP-123456"], noMatch: ["EMP-1"] } }],
  ["context", { name: "X", match: { type: "context", keywords: ["account"], value: { kind: "digits", length: 8 } }, examples: { match: ["account 12345678"], noMatch: ["12345678"] } }],
  ["list", { name: "X", match: { type: "list", terms: ["Falcon-9X"] }, examples: { match: ["Falcon-9X"], noMatch: ["Falcon"] } }],
  ["known:uuid", { name: "X", match: { type: "known", format: "uuid" }, examples: { match: ["550e8400-e29b-41d4-a716-446655440000"], noMatch: ["nope"] } }],
]) {
  const { compiled, errors } = compilePattern(pat, label);
  ok(`${label} compiles with no errors`, errors.length === 0 && !!compiled, errors.join("; "));
}

// ── 3. Custom pattern flows through scan → buildSwap → rehydrate ────────
console.error("\n── end-to-end swap/rehydrate ─────────────────────");
{
  const { loaded } = tryLoad(VALID);
  const det = { customPatterns: loaded.customPatterns };
  const text = "ticket for EMP-778899 about account 80042217";
  const { findings } = scan(text, det);
  const emp = findings.find((f) => f.value === "EMP-778899");
  ok("custom prefix pattern detected", !!emp);
  ok("finding type is custom", emp && emp.type === "custom");
  ok("maskHint carries the label", emp && emp.maskHint === "Employee ID");
  const swap = buildSwap(text, findings, "salt");
  const empMap = swap.mappings.find((m) => m.real === "EMP-778899");
  ok("mock shaped from label", empMap && /^WYLOC_MOCK_EMPLOYEE_ID_/.test(empMap.mock), empMap && empMap.mock);
  ok("real value gone from swapped text", !swap.swappedText.includes("EMP-778899"));
  const back = rehydrate(swap.swappedText, swap.mappings);
  ok("rehydrate restores the real value", back.includes("EMP-778899"));
}

// ── 4. Internal scopes reach the code masker ───────────────────────────
console.error("\n── internal scopes -> code masker ────────────────");
{
  const { loaded } = tryLoad(VALID);
  const cm = new CodeMasker(resolveCodeCfg({ internalScopes: loaded.internalScopes }));
  const r = cm.mask(`import { Thing } from "@acme/widgets";\nexport const x = new Thing();`, "f.ts");
  ok("@acme/* import treated as internal (masked)", !/\bThing\b/.test(r.masked), r.masked);
}

// ── 5. Invalid configs FAIL-CLOSED with specific errors ────────────────
console.error("\n── fail-closed validation ────────────────────────");
function expectErr(name, obj, needle) {
  const { err } = tryLoad(obj);
  const hit = err instanceof WylocConfigError && err.problems.some((p) => p.includes(needle));
  ok(name, hit, err instanceof WylocConfigError ? err.problems.join(" | ") : "did not throw");
}
expectErr("unknown key rejected w/ did-you-mean", { version: 1, patturns: [] }, "did you mean");
expectErr("bad version rejected", { version: 2 }, "version");
expectErr("prefix missing format rejected", { version: 1, patterns: [{ name: "x", match: { type: "prefix", prefix: "E-" } }] }, "format");
expectErr("context window > 256 rejected", { version: 1, patterns: [{ name: "x", match: { type: "context", keywords: ["a"], value: { kind: "digits", length: 4 }, window: 9999 } }] }, "window");
expectErr("format length < 1 rejected", { version: 1, patterns: [{ name: "x", match: { type: "prefix", prefix: "E-", format: { kind: "digits", length: 0 } } }] }, "length");
expectErr("duplicate ids rejected", { version: 1, patterns: [
  { name: "a", id: "dup", match: { type: "list", terms: ["a"] } },
  { name: "b", id: "dup", match: { type: "list", terms: ["b"] } }] }, "duplicate");
expectErr("failed self-test rejected", { version: 1, patterns: [
  { name: "x", match: { type: "prefix", prefix: "EMP-", format: { kind: "digits", length: 6 } }, examples: { match: ["NOPE-1"] } }] }, "did not");
expectErr("not-JSON rejected", "{ this is not json", "JSON");

// ── 6. Dangerous raw regex rejected (ReDoS), and raw-without-RE2 fail-closed ──
console.error("\n── raw regex safety ──────────────────────────────");
ok("findReDoSRisk flags (a+)+", findReDoSRisk("(a+)+") !== null);
ok("findReDoSRisk flags (.*)*", findReDoSRisk("(.*)*") !== null);
ok("findReDoSRisk passes a safe pattern", findReDoSRisk("\\bEMP-\\d{6}\\b") === null);
expectErr("catastrophic raw regex rejected at load",
  { version: 1, patterns: [{ name: "bad", match: { type: "regex", advanced: true, source: "(a+)+$" }, examples: { match: ["aaaa"] } }] },
  "catastrophic");
expectErr("raw regex requires advanced:true",
  { version: 1, patterns: [{ name: "r", match: { type: "regex", source: "TKT-\\d{4}" }, examples: { match: ["TKT-1234"] } }] },
  "advanced");
// Safe raw regex: rejected here ONLY because RE2 isn't installed (fail-closed).
expectErr("safe raw regex fail-closed without RE2",
  { version: 1, patterns: [{ name: "r", match: { type: "regex", advanced: true, source: "TKT-\\d{4}" }, examples: { match: ["TKT-1234"] } }] },
  "RE2");

// ── 7. Precedence: wyloc.json policy overrides env ─────────────────────
console.error("\n── precedence (config > env) ─────────────────────");
{
  const env = { ...loadConfig(), maskSql: true, maskFileReads: true }; // pretend env enabled SQL
  const { loaded } = tryLoad({ version: 1, policy: { sql: false } });
  const merged = applyWyloc(env, loaded);
  ok("wyloc policy.sql=false overrides env maskSql=true", merged.maskSql === false);
  ok("env field kept when wyloc silent (fileReads)", merged.maskFileReads === true);
}

// ── 8. No file present -> null (backward compatible) ───────────────────
{
  const loaded = loadWylocConfig(join(dir, "does-not-exist.json"));
  ok("missing file -> null (env-only behavior)", loaded === null);
}

console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
