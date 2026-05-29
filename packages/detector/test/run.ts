/**
 * Fixture + unit test runner for @ai-dlp/detector.
 *
 * Run with: npm test  (uses tsx, no test framework dependency).
 *
 * Output is designed to double as a tuning report — false positives and
 * false negatives are listed individually so you can see exactly which
 * fixture moved when you change a pattern or threshold.
 */

import { scan, redact, maskValue, scanToIncidents, buildSwap, rehydrate } from "../src/index.js";
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

// --- Dummy-swap engine -------------------------------------------------
console.log("── Dummy-swap engine ─────────────────────────────────────");
{
  // 1. Basic swap: secret is removed, mock is present, mapping returned.
  {
    const text = "my key is AKIA5XQ2WJ8NPLR3MKVT and that's it";
    const { findings } = scan(text);
    const { swappedText, mappings } = buildSwap(text, findings, "salt1");
    check(
      "swap: real value removed from text",
      !swappedText.includes("AKIA5XQ2WJ8NPLR3MKVT"),
      "real secret survived the swap",
    );
    check("swap: a mapping was produced", mappings.length > 0);
    check(
      "swap: mock is an obvious WYLOC placeholder",
      mappings.some((m) => /^WYLOC_MOCK_/.test(m.mock)),
      `got mocks [${mappings.map((m) => m.mock).join(", ")}]`,
    );
  }

  // 2. Determinism: same secret + same salt => identical mock.
  {
    const text = "AKIA5XQ2WJ8NPLR3MKVT";
    const a = buildSwap(text, scan(text).findings, "salt-X");
    const b = buildSwap(text, scan(text).findings, "salt-X");
    check(
      "swap: deterministic for same salt",
      a.mappings[0]?.mock === b.mappings[0]?.mock,
      `${a.mappings[0]?.mock} !== ${b.mappings[0]?.mock}`,
    );
  }

  // 3. Salt sensitivity: different salt => different mock.
  {
    const text = "AKIA5XQ2WJ8NPLR3MKVT";
    const a = buildSwap(text, scan(text).findings, "salt-A");
    const b = buildSwap(text, scan(text).findings, "salt-B");
    check(
      "swap: different salt yields different mock",
      a.mappings[0]?.mock !== b.mappings[0]?.mock,
      "salts produced identical mocks",
    );
  }

  // 4. Repeated secret collapses to ONE consistent mock.
  {
    const text =
      "first AKIA5XQ2WJ8NPLR3MKVT then again AKIA5XQ2WJ8NPLR3MKVT end";
    const { findings } = scan(text);
    const { swappedText, mappings } = buildSwap(text, findings, "s");
    const uniqueReals = new Set(mappings.map((m) => m.real));
    check(
      "swap: repeated secret => one mapping",
      uniqueReals.size === 1,
      `got ${uniqueReals.size} mappings for one repeated secret`,
    );
    // The mock should appear twice in the swapped text.
    const mock = mappings[0]?.mock ?? "";
    const occurrences = swappedText.split(mock).length - 1;
    check(
      "swap: consistent mock used for both occurrences",
      occurrences === 2,
      `mock appeared ${occurrences} times, expected 2`,
    );
  }

  // 5. Round-trip: rehydrate(swap(text)) restores the original secret.
  {
    const text = "token AKIA5XQ2WJ8NPLR3MKVT here";
    const { findings } = scan(text);
    const { swappedText, mappings } = buildSwap(text, findings, "rt");
    const restored = rehydrate(swappedText, mappings);
    check(
      "swap: round-trip restores original",
      restored === text,
      `got "${restored}"`,
    );
  }

  // 6. Database URL keeps its structure (scheme + port preserved).
  {
    const text =
      "DATABASE_URL=postgresql://admin:Sup3rS3cr3tP4ss@db.prod.internal:5432/main";
    const { findings } = scan(text);
    const { swappedText, mappings } = buildSwap(text, findings, "db");
    check(
      "swap: db url password removed",
      !swappedText.includes("Sup3rS3cr3tP4ss"),
      "db password survived",
    );
    const dbMock = mappings.find((m) => m.type === "database_url")?.mock ?? "";
    check(
      "swap: db url keeps scheme + port",
      dbMock.startsWith("postgresql://") && dbMock.includes(":5432"),
      `got "${dbMock}"`,
    );
  }

  // 7. PEM private key produces a structurally complete block.
  {
    const mock = buildSwap(
      "x",
      [
        {
          layer: "known_pattern",
          type: "private_key",
          confidence: "high",
          start: 0,
          end: 1,
          value: "x",
          environment: "unknown",
          reason: "",
          ruleId: "test",
        },
      ],
      "pem",
    ).mappings[0].mock;
    check(
      "swap: private key mock is an obvious placeholder",
      mock.startsWith("WYLOC_MOCK_PRIVATE_KEY_"),
      `got "${mock}"`,
    );
  }

  // 8. No findings => text unchanged, no mappings.
  {
    const text = "just a normal sentence with no secrets";
    const { swappedText, mappings } = buildSwap(text, [], "n");
    check("swap: empty findings leaves text intact", swappedText === text);
    check("swap: empty findings yields no mappings", mappings.length === 0);
  }

  // 9. Mock must NOT equal the real value (true substitution).
  {
    const text = "AKIA5XQ2WJ8NPLR3MKVT";
    const { mappings } = buildSwap(text, scan(text).findings, "neq");
    check(
      "swap: mock differs from real",
      mappings.every((m) => m.mock !== m.real),
      "a mock equalled its real value",
    );
  }
}


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
