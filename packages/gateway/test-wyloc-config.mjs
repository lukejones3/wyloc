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
import { compilePattern, loadRe2 } from "./src/wyloc/compile.ts";
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
// Safe raw regex depends on RE2 availability (env-dependent, so test BOTH):
//   • RE2 present  → compiles and loads (the real raw-regex path; CI/Node-22).
//   • RE2 absent   → FAIL-CLOSED with an RE2 message (e.g. Node-25 sandbox).
{
  const rawCfg = { version: 1, patterns: [{ name: "r", match: { type: "regex", advanced: true, source: "TKT-\\d{4}" }, examples: { match: ["TKT-1234"] } }] };
  const re2Available = !!loadRe2();
  const { loaded, err } = tryLoad(rawCfg);
  if (re2Available) {
    ok("safe raw regex COMPILES when RE2 is available", !err && loaded && loaded.customPatterns.length === 1, err && String(err.problems));
  } else {
    ok("safe raw regex FAIL-CLOSED without RE2", err instanceof WylocConfigError && err.problems.some((p) => p.includes("RE2")), "expected an RE2 fail-closed error");
  }
}

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

// ── 9. Sensible DEFAULTS: common languages ON, COBOL opt-in, TS/JS+SQL ON ──
console.error("\n── sensible defaults ─────────────────────────────");
{
  // A pristine env (no WYLOC_MASK_* set) must give baseline coverage.
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("WYLOC_MASK")) delete process.env[k];
  const c = loadConfig();
  process.env = clean; // restore
  const COMMON = ["go", "java", "csharp", "kotlin", "python", "rust", "c", "cpp"];
  ok("default masks the 8 common languages", COMMON.every((l) => c.maskLanguages.includes(l)),
    c.maskLanguages.join(","));
  ok("default does NOT include COBOL (opt-in)", !c.maskLanguages.includes("cobol"));
  ok("default TS/JS masking ON", c.maskCode === true);
  ok("default SQL masking ON", c.maskSql === true);
  ok("default file-read masking ON", c.maskFileReads === true);
}

// ── 10. `languages` keyword expansion + narrowing, via wyloc.json ──────
console.error("\n── languages keyword expansion ───────────────────");
{
  const base = { ...loadConfig() };
  const narrow = applyWyloc(base, tryLoad({ version: 1, languages: ["go", "python"] }).loaded);
  ok("narrow list is authoritative", narrow.maskLanguages.join(",") === "go,python");

  const addCobol = applyWyloc(base, tryLoad({ version: 1, languages: ["defaults", "cobol"] }).loaded);
  ok("[defaults,cobol] expands to common set + COBOL",
    addCobol.maskLanguages.includes("cobol") && addCobol.maskLanguages.includes("go") && addCobol.maskLanguages.length === 9,
    addCobol.maskLanguages.join(","));

  const all = applyWyloc(base, tryLoad({ version: 1, languages: ["all"] }).loaded);
  ok("[all] includes COBOL", all.maskLanguages.includes("cobol") && all.maskLanguages.length === 9);

  const off = applyWyloc(base, tryLoad({ version: 1, languages: ["none"] }).loaded);
  ok("[none] disables poly masking", off.maskLanguages.length === 0);

  // Unknown language id fails closed with a did-you-mean hint.
  const { err } = tryLoad({ version: 1, languages: ["pythn"] });
  ok("unknown language fails closed", err instanceof WylocConfigError);
  ok("unknown language suggests the right id", err?.problems?.some((p) => p.includes("python")), String(err?.problems));

  // A keyword typo is also caught + suggested.
  const { err: kwErr } = tryLoad({ version: 1, languages: ["defalts"] });
  ok("keyword typo suggests 'defaults'", kwErr?.problems?.some((p) => p.includes("defaults")), String(kwErr?.problems));

  // internalPackagePrefixes accepts all nine languages (incl. the last four).
  const { loaded: ippLoaded, err: ippErr } = tryLoad({
    version: 1,
    internalPackagePrefixes: { rust: ["voltra_billing"], cobol: [], cpp: ["voltra"], c: [] },
  });
  ok("internalPackagePrefixes accepts rust/c/cpp/cobol", !ippErr && ippLoaded !== undefined, String(ippErr?.problems));
}

// ── 11. The SHIPPED example config loads clean (doc-rot guard) ─────────
console.error("\n── shipped example loads ─────────────────────────");
{
  const examplePath = new URL("./wyloc.example.json", import.meta.url).pathname;
  let loaded, err;
  try { loaded = loadWylocConfig(examplePath); } catch (e) { err = e; }
  ok("wyloc.example.json loads without error", !err && loaded !== null, String(err?.problems ?? err));
  ok("example's languages:['defaults'] resolves to the common set",
    loaded && applyWyloc(loadConfig(), loaded).maskLanguages.length === 8);
}

console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
