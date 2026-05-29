/**
 * Fixture + unit test runner for @ai-dlp/detector.
 *
 * Run with: npm test  (uses tsx, no test framework dependency).
 *
 * Output is designed to double as a tuning report — false positives and
 * false negatives are listed individually so you can see exactly which
 * fixture moved when you change a pattern or threshold.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// --- Per-definition fixtures: every pattern validates its own fixtures --
//
// Fixtures travel with each JSON definition. Here we iterate every
// definition and assert, through the real scan pipeline, that each positive
// fixture fires THAT pattern (by ruleId) and each negative fixture does not.
// Because the compiler already fails the build on a definition with no
// positive fixtures, adding a pattern forces adding its tests.
console.log("── Per-definition fixtures (each pattern tests itself) ────");
{
  const defsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "patterns",
    "definitions",
  );
  const files = readdirSync(defsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  check("definitions directory is non-empty", files.length > 0);

  for (const file of files) {
    const def = JSON.parse(readFileSync(join(defsDir, file), "utf8")) as {
      id: string;
      fixtures?: { positive?: string[]; negative?: string[] };
    };
    const positive = def.fixtures?.positive ?? [];
    const negative = def.fixtures?.negative ?? [];

    check(
      `[def] ${def.id}: has positive fixtures`,
      positive.length > 0,
      positive.length === 0 ? "definition carries no positive fixtures" : "",
    );

    for (const text of positive) {
      const { findings } = scan(text);
      check(
        `[def] ${def.id}: matches +${JSON.stringify(text.slice(0, 28))}`,
        findings.some((f) => f.ruleId === def.id),
        `fired [${findings.map((f) => f.ruleId).join(", ") || "none"}]`,
      );
    }
    for (const text of negative) {
      const { findings } = scan(text);
      check(
        `[def] ${def.id}: rejects -${JSON.stringify(text.slice(0, 28))}`,
        !findings.some((f) => f.ruleId === def.id),
        "pattern fired on a negative fixture",
      );
    }
  }
}

// --- Build-time tier_3 gate: the compiler MUST reject unsafe definitions --
//
// The schema's types already forbid a tier_3 pattern without requiredContext,
// but JSON authoring is not type-checked — the compiler is the real gate. We
// drive the compiler against intentionally-bad fixture definitions and assert
// it fails the build (non-zero exit). If someone later weakens that check,
// these tests fail. A passing control proves the harness distinguishes
// success from failure (i.e. it is not just always-erroring).
console.log("── Build-time tier_3 gate (compiler rejects unsafe defs) ──");
{
  const testDir = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(testDir, "..");
  const compiler = join(pkgRoot, "scripts", "compile-patterns.ts");
  const badRoot = join(testDir, "fixtures", "bad-definitions");

  const runCompiler = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", compiler, ...args], {
      cwd: pkgRoot,
      encoding: "utf8",
    });

  const badCases = [
    { name: "no requiredContext field", dir: "missing-required-context" },
    { name: "empty requiredContext array", dir: "empty-required-context" },
  ];
  for (const c of badCases) {
    const r = runCompiler(["--dir", join(badRoot, c.dir)]);
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    check(
      `[build] rejects tier_3 with ${c.name} (non-zero exit)`,
      r.status !== 0,
      `expected non-zero exit, got ${r.status}`,
    );
    check(
      `[build] error names the requiredContext gate (${c.name})`,
      /requiredContext/.test(output),
      `output: ${output.trim().slice(0, 140) || "(empty)"}`,
    );
  }

  // Positive control: the real, valid definitions compile cleanly.
  const ctrlOut = join(tmpdir(), `wyloc-compile-control-${Date.now()}.ts`);
  const good = runCompiler([
    "--dir",
    join(pkgRoot, "src", "patterns", "definitions"),
    "--out",
    ctrlOut,
  ]);
  check(
    "[build] control: valid definitions compile (exit 0)",
    good.status === 0,
    `expected exit 0, got ${good.status}: ${(good.stderr ?? "").trim().slice(0, 140)}`,
  );
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
