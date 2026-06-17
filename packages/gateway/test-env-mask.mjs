/**
 * .env value-masking unit tests.
 * Run with: node --import tsx test-env-mask.mjs
 */
import { looksLikeEnv, maskEnvValues } from "./src/env-mask.ts";
import { rehydrate } from "@wyloc/detector";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

// A realistically messy .env: export prefix, quoted values, = inside values,
// empty value, inline comment, mixed-case key, section header, comments,
// multiline quoted value.
const ENV = [
  "# App config",
  'export DATABASE_URL="postgres://admin:s3cr3t@db.internal:5432/app?sslmode=require"',
  "API_KEY=sk_live_abc123==",
  "admin_code = 4815  # the door code",
  "EMPTY=",
  "QUOTED='single quoted value'",
  "FLAG_SALT=xyz==base64==",
  "",
  "[section]",
  "HOST=localhost",
  'MULTI="line one',
  'line two"',
].join("\n");

// ── sniff ──
ok("sniff: messy .env detected", looksLikeEnv(ENV));
ok("sniff: code block NOT env", !looksLikeEnv("const a = 1;\nconst b = 2;\nfunction f() { return a; }"));
ok("sniff: ;-terminated assignments (code) NOT env", !looksLikeEnv("foo = 1;\nbar = 2;\nbaz = 3;"));
ok("sniff: prose mentioning KEY=value NOT env", !looksLikeEnv("Set FOO=bar to enable the thing.\nThen restart."));
ok("sniff: single assignment NOT env", !looksLikeEnv("just FOO=bar here"));

// ── mask values ──
const { out, mappings } = maskEnvValues(ENV, "salt");

ok("real values gone", !out.includes("s3cr3t") && !out.includes("sk_live_abc123") && !out.includes("single quoted value") && !out.includes("xyz==base64==") && !out.includes("line one"));
ok("keys preserved", ["DATABASE_URL", "API_KEY", "admin_code", "EMPTY", "QUOTED", "FLAG_SALT", "HOST", "MULTI"].every((k) => out.includes(k)));
ok("export prefix preserved", /export DATABASE_URL=/.test(out));
ok("double quotes preserved", /DATABASE_URL="WYLOC_MOCK_/.test(out));
ok("single quotes preserved", /QUOTED='WYLOC_MOCK_/.test(out));
ok("= inside value handled (split on first =)", /API_KEY=WYLOC_MOCK_/.test(out) && !out.includes("sk_live"));
ok("empty value left untouched", /(^|\n)EMPTY=(\n|$)/.test(out));
ok("inline comment preserved, value masked", /admin_code = WYLOC_MOCK_\S+\s+# the door code/.test(out), out.split("\n").find((l) => l.startsWith("admin_code")));
ok("section header untouched", out.includes("[section]"));
ok("comment lines preserved", out.includes("# App config"));
ok("multiline quoted value masked across span", /MULTI="WYLOC_MOCK_\S+"/.test(out), out.split("MULTI")[1]);
ok("localhost (no-pattern value) masked — the .env point", !out.includes("localhost"));
ok("output still sniffs as a valid env file", looksLikeEnv(out));

// ── round-trip ──
const back = rehydrate(out, mappings);
ok("round-trip rehydrates to the original byte-for-byte", back === ENV, back === ENV ? "" : "mismatch");

// ── unterminated quote → that value left untouched (fallback), others masked ──
{
  const bad = ['A=1', 'B="unterminated', 'C=3'].join("\n");
  const r = maskEnvValues(bad, "salt");
  ok("unterminated quote: that line left as-is", r.out.includes('B="unterminated'));
  ok("unterminated quote: other values still masked", !/(^|\n)A=1(\n|$)/.test(r.out) && !/(^|\n)C=3(\n|$)/.test(r.out));
}

console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
console.error("✓ env-mask unit test PASSED");
