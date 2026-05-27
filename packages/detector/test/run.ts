/**
 * Fixture + unit test runner for @ai-dlp/detector.
 *
 * Run with: npm test  (uses tsx, no test framework dependency).
 *
 * Output is designed to double as a tuning report — false positives and
 * false negatives are listed individually so you can see exactly which
 * fixture moved when you change a pattern or threshold.
 */

import { scan, redact, maskValue, scanToIncidents } from "../src/index.js";
import { positiveFixtures } from "./fixtures/positive.js";
import { negativeFixtures } from "./fixtures/negative.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Positive fixtures: must fire, correct type, correct action --------
console.log("\n── Positive fixtures (must detect) ───────────────────────");
for (const fx of positiveFixtures) {
  const { findings, decision } = scan(fx.text);
  const types = findings.map((f) => f.type);
  const hitType = types.includes(fx.expectType as never);

  check(
    `[+] ${fx.name}: detected`,
    findings.length > 0,
    findings.length === 0 ? "no findings" : "",
  );
  check(
    `[+] ${fx.name}: type = ${fx.expectType}`,
    hitType,
    hitType ? "" : `got [${types.join(", ") || "none"}]`,
  );
  check(
    `[+] ${fx.name}: action = ${fx.expectAction}`,
    decision.action === fx.expectAction,
    decision.action === fx.expectAction
      ? ""
      : `got "${decision.action}"`,
  );
}

// --- Negative fixtures: must NOT fire ----------------------------------
console.log("── Negative fixtures (must stay silent) ──────────────────");
for (const fx of negativeFixtures) {
  const { findings } = scan(fx.text);
  check(
    `[-] ${fx.name}: no findings`,
    findings.length === 0,
    findings.length > 0
      ? `false positive: [${findings
          .map((f) => `${f.type}@${f.start}`)
          .join(", ")}]`
      : "",
  );
}

// --- Unit checks: policy invariants ------------------------------------
console.log("── Policy invariants ─────────────────────────────────────");
{
  // A dev-context high-confidence vendor key must NOT block.
  const devKey = scan(
    "in our dev sandbox the test key is AKIA2RZ4QF7KJ9XW1MTL",
  );
  check(
    "dev-context AWS key warns, never blocks",
    devKey.decision.action === "warn",
    `got "${devKey.decision.action}"`,
  );

  // Empty input is clean.
  const empty = scan("");
  check("empty input -> no findings", empty.findings.length === 0);
  check("empty input -> allow", empty.decision.action === "allow");

  // Entropy-only with no context is dropped by default config.
  const loneEntropy = scan(
    "value is qX7vN2pR9mK4tL8wZ1cB6dF3gH0jY5sA8eT2uW6",
  );
  check(
    "lone high-entropy string dropped without context",
    loneEntropy.findings.length === 0,
    loneEntropy.findings.length > 0
      ? `got ${loneEntropy.findings.length} finding(s)`
      : "",
  );
}

// --- Unit checks: redaction --------------------------------------------
console.log("── Redaction ─────────────────────────────────────────────");
{
  const text = "key AKIA2RZ4QF7KJ9XW1MTL here";
  const { findings } = scan(text);
  const red = redact(text, findings);
  check(
    "redact replaces the secret value",
    !red.includes("AKIA2RZ4QF7KJ9XW1MTL"),
    `got "${red}"`,
  );
  check(
    "redact inserts a typed placeholder",
    red.includes("[REDACTED_AWS_ACCESS_KEY]"),
    `got "${red}"`,
  );
  check(
    "maskValue shows only first 4 chars",
    maskValue("AKIA2RZ4QF7KJ9XW1MTL").startsWith("AKIA") &&
      !maskValue("AKIA2RZ4QF7KJ9XW1MTL").includes("2RZ4"),
  );
}

// --- Unit checks: incident metadata is value-free ----------------------
console.log("── Incident metadata (no leakage) ────────────────────────");
{
  const text =
    "DATABASE_URL=postgresql://admin:Sup3rS3cr3tP4ss@db.prod.internal/main";
  const { incidents } = scanToIncidents(text, "cli");
  check("incident produced", incidents.length > 0);
  const serialized = JSON.stringify(incidents);
  check(
    "incident JSON contains no secret value",
    !serialized.includes("Sup3rS3cr3tP4ss"),
    "secret leaked into incident metadata",
  );
  check(
    "incident JSON contains no raw prompt text",
    !serialized.includes("DATABASE_URL="),
    "prompt text leaked into incident metadata",
  );
  check(
    "incident carries a secret type",
    incidents.every((i) => typeof i.secretType === "string"),
  );
}

// --- Summary -----------------------------------------------------------
console.log("\n──────────────────────────────────────────────────────────");
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(f);
  console.log("");
}
const total = passed + failed;
console.log(`${passed}/${total} checks passed.`);
if (failed > 0) {
  console.log(`${failed} FAILED.`);
  process.exit(1);
} else {
  console.log("All checks passed. ✓");
}
