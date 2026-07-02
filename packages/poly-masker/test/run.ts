/**
 * Test runner for @wyloc/poly-masker. No test framework — run with: npm test
 * (uses tsx). Mirrors the code-masker runner: check() assertions, per-fixture
 * groups, and a Phase-2 (masking) + Phase-3 (rehydration/round-trip) split.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyMasker, PolyMaskError, ProjectIndex, discoverInternalPrefixes, rehydrate } from "../src/index.js";
import { parserFor } from "../src/parsers.js";
import { countParseErrors } from "../src/tree.js";
import { APP_GO, EXTERNAL_ONLY_GO, SHADOWED_QUALIFIER_GO, INTERNAL_MODULE } from "./fixtures/go.js";
import { APP_JAVA, EXTERNAL_ONLY_JAVA, WILDCARD_IMPORT_JAVA, JAVA_PREFIXES } from "./fixtures/java.js";
import { APP_CSHARP, SIBLING_CS, EXTERNAL_ONLY_CSHARP, CSHARP_PREFIXES } from "./fixtures/csharp.js";
import { APP_KOTLIN, EXTERNAL_ONLY_KOTLIN, KOTLIN_PREFIXES } from "./fixtures/kotlin.js";
import { APP_PY, EXTERNAL_ONLY_PY, PYTHON_PREFIXES } from "./fixtures/python.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const wordPresent = (hay: string, w: string) =>
  new RegExp(`(?<![A-Za-z0-9_$])${w}(?![A-Za-z0-9_$])`).test(hay);
const wordCount = (hay: string, w: string) =>
  (hay.match(new RegExp(`(?<![A-Za-z0-9_$])${w}(?![A-Za-z0-9_$])`, "g")) ?? []).length;

async function goParseErrors(code: string): Promise<number> {
  const parser = await parserFor("go");
  const tree = parser.parse(code);
  return tree ? countParseErrors(tree.rootNode) : Infinity;
}

function goMasker() {
  return PolyMasker.create({
    languages: ["go"],
    internalPackagePrefixes: { go: [INTERNAL_MODULE] },
  });
}

async function main(): Promise<void> {
  // ====================================================================
  // PHASE 2 — MASKING (Go)
  // ====================================================================
  console.log("\n══ Phase 2: masking (go) ═════════════════════════════════");

  // ---- Primary fixture: APP_GO ----
  {
    const masker = goMasker();
    const r = await masker.mask(APP_GO, "go");
    const m = r.masked;
    const g = "[go/app]";

    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) internal declarations masked + correctly classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} Retryable -> interface`, kindOf("Retryable") === "interface");
    check(`${g} DunningPolicy -> type`, kindOf("DunningPolicy") === "type");
    check(`${g} NewInvoiceReconciler -> function`, kindOf("NewInvoiceReconciler") === "function");
    check(`${g} RegisterRoutes -> function`, kindOf("RegisterRoutes") === "function");
    check(`${g} package billing -> namespace`, kindOf("billing") === "namespace");

    // (a') internal-import bindings
    check(`${g} ledger.Client selector -> import`, kindOf("Client") === "import");
    check(`${g} ledger.PostEntry selector -> import`, kindOf("PostEntry") === "import");
    check(`${g} fx.Provider selector -> import`, kindOf("Provider") === "import");
    check(`${g} qualifier ledger -> namespace`, kindOf("ledger") === "namespace");
    check(`${g} alias fx -> namespace`, kindOf("fx") === "namespace");

    // (b) real proprietary names GONE from output
    for (const real of [
      "InvoiceReconciler", "ReconcileResult", "Retryable", "DunningPolicy",
      "NewInvoiceReconciler", "RegisterRoutes", "billing",
    ]) {
      check(`${g} "${real}" absent from output`, !wordPresent(m, real));
    }
    check(`${g} internal module path absent`, !m.includes("voltra/billing-core"));

    // (c) consistency: every CODE reference renamed to the SAME mask (the
    // fixture also mentions the names in comments, which are stripped —
    // 5 and 3 are the code-reference counts).
    const reconcilerMask = maskOf("InvoiceReconciler")!;
    check(`${g} InvoiceReconciler consistently renamed (5 refs)`, wordCount(m, reconcilerMask) === 5,
      `got ${wordCount(m, reconcilerMask)}`);
    const resultMask = maskOf("ReconcileResult")!;
    check(`${g} ReconcileResult consistently renamed (3 refs)`, wordCount(m, resultMask) === 3,
      `got ${wordCount(m, resultMask)}`);

    // (d) NEVER-touch: stdlib + third-party identifiers intact (make-or-break)
    for (const ext of [
      "context", "fmt", "http", "time", "gin", "zap", "decimal",
      "RouterGroup", "Logger", "NewFromInt", "StatusOK", "StatusInternalServerError",
      "Errorf", "Timeout", "Client",
    ]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external import paths untouched`, m.includes("github.com/gin-gonic/gin") && m.includes("go.uber.org/zap"));
    // http.Client survives even though ledger.Client was masked (span-targeted rename)
    check(`${g} http.Client survives`, m.includes("http.Client"));
    check(`${g} ledger.Client did not survive`, !m.includes("ledger.Client"));

    // (e) members/fields untouched (member masking off)
    for (const member of ["OpenEntries", "Lookup", "Warn", "BatchID", "Matched", "Failed", "Currency", "AmountMinor"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }

    // (f) internal URL host masked; secret swapped. (The detector's
    // env-assignment rule then swaps the whole const VALUE to a mock — same
    // detector-last behavior as the TS masker; both levels round-trip.)
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} host recorded in maskedStrings`, r.maskedStrings.some((s) => s.real === "ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} AWS mock present`, r.swappedSecrets.some((s) => s.mock.includes("AWS")));

    // (g) comments stripped
    check(`${g} comments gone`, !m.includes("//"));
    check(`${g} runbook comment gone`, !m.includes("payments-core"));

    // (h) masked output re-parses as valid Go
    check(`${g} output re-parses clean`, (await goParseErrors(m)) === 0);

    // (i) module specifier masked but still import-shaped
    const spec = r.maskedModuleSpecifiers.find((s) => s.real.includes("internal/ledger"));
    check(`${g} internal path -> masked/mod_<h>`, !!spec && /^masked\/mod_[a-z0-9]+$/.test(spec.mask));
    check(`${g} masked path in output`, !!spec && m.includes(`"${spec.mask}"`));

    // (j) determinism: same input → identical output (salt = "")
    const r2 = await goMasker().mask(APP_GO, "go");
    check(`${g} deterministic`, r2.masked === m);

    // (k) detector idempotency: re-masking the MASKED output must not re-swap
    // any WYLOC_MOCK_ placeholder (the invariant from the recent gateway fix).
    const r3 = await goMasker().mask(m, "go");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives verbatim`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0,
      `re-swapped: ${r3.swappedSecrets.map((s) => s.mock).join(", ")}`);
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_GO (the make-or-break check) ----
  {
    const masker = goMasker();
    const r = await masker.mask(EXTERNAL_ONLY_GO, "go");
    const m = r.masked;
    const g = "[go/external-only]";

    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    check(`${g} package main kept`, m.includes("package main"));
    check(`${g} func main kept`, m.includes("func main()"));
    for (const ext of ["gin", "decimal", "http", "strings", "Getenv", "NewFromString", "StatusBadRequest"]) {
      check(`${g} "${ext}" untouched`, wordPresent(m, ext));
    }
    check(`${g} output re-parses clean`, (await goParseErrors(m)) === 0);
  }

  // ---- Shadowed qualifier: conservative skip, no partial mask ----
  {
    const r = await goMasker().mask(SHADOWED_QUALIFIER_GO, "go");
    const g = "[go/shadowed]";
    check(`${g} shadowed import path untouched`, r.masked.includes("github.com/voltra/billing-core/internal/ledger"));
    check(`${g} local param not renamed`, wordPresent(r.masked, "ledger"));
    // ("billing" still appears inside the untouched import path — assert on
    // the package CLAUSE, which must be masked.)
    check(`${g} package still masked`, !/(^|\n)package billing\b/.test(r.masked));
    check(`${g} output re-parses clean`, (await goParseErrors(r.masked)) === 0);
  }

  // ---- Graceful degradation: parse failure throws PolyMaskError ----
  {
    let threw = false;
    try {
      await goMasker().mask("func { this is not go ][", "go");
    } catch (e) {
      threw = e instanceof PolyMaskError;
    }
    check("[go/degrade] garbage input throws PolyMaskError", threw);

    let disabledThrew = false;
    try {
      await PolyMasker.create({ languages: [] }).mask(APP_GO, "go");
    } catch (e) {
      disabledThrew = e instanceof PolyMaskError;
    }
    check("[go/degrade] disabled language throws PolyMaskError", disabledThrew);
  }

  // ---- go.mod auto-discovery ----
  {
    const dir = mkdtempSync(join(tmpdir(), "wyloc-poly-"));
    try {
      writeFileSync(join(dir, "go.mod"), `module ${INTERNAL_MODULE}\n\ngo 1.22\n`);
      writeFileSync(join(dir, "pom.xml"), `<project><groupId>com.voltra</groupId><artifactId>billing</artifactId></project>`);
      writeFileSync(join(dir, "Voltra.Billing.csproj"), `<Project><PropertyGroup><RootNamespace>Voltra.Billing</RootNamespace></PropertyGroup></Project>`);
      writeFileSync(join(dir, "pyproject.toml"), `[project]\nname = "voltra-billing"\n`);
      const found = discoverInternalPrefixes(dir);
      check("[discover] go.mod module found", found.go?.[0] === INTERNAL_MODULE);
      check("[discover] pom groupId -> java+kotlin prefixes", found.java?.[0] === "com.voltra." && found.kotlin?.[0] === "com.voltra.");
      check("[discover] csproj RootNamespace -> csharp prefix", found.csharp?.[0] === "Voltra.");
      check("[discover] pyproject name -> python package", found.python?.[0] === "voltra_billing");
      check("[discover] empty root finds nothing", Object.keys(discoverInternalPrefixes("")).length === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // PHASE 2 — MASKING (Java)
  // ====================================================================
  console.log("══ Phase 2: masking (java) ═══════════════════════════════");
  const javaMasker = () =>
    PolyMasker.create({ languages: ["java"], internalPackagePrefixes: { java: [...JAVA_PREFIXES] } });
  const javaParseErrors = async (code: string) => {
    const parser = await parserFor("java");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_JAVA ----
  {
    const r = await javaMasker().mask(APP_JAVA, "java");
    const m = r.masked;
    const g = "[java/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) internal declarations + import bindings masked and classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult (nested record) -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} LedgerClient -> import`, kindOf("LedgerClient") === "import");
    check(`${g} LedgerEntry -> import`, kindOf("LedgerEntry") === "import");
    check(`${g} FxRateProvider -> import`, kindOf("FxRateProvider") === "import");
    check(`${g} package -> namespace`, kindOf("com.voltra.billing") === "namespace");

    // (b) real proprietary names GONE
    for (const real of ["InvoiceReconciler", "ReconcileResult", "LedgerClient", "LedgerEntry", "FxRateProvider"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} internal package paths absent`, !m.includes("com.voltra"));

    // (c) consistency: every code reference renamed to the same mask
    check(`${g} InvoiceReconciler consistently renamed (3 refs: class, getLogger, ctor)`, wordCount(m, maskOf("InvoiceReconciler")!) === 3,
      `got ${wordCount(m, maskOf("InvoiceReconciler")!)}`);
    check(`${g} LedgerEntry consistently renamed (5 refs)`, wordCount(m, maskOf("LedgerEntry")!) === 5,
      `got ${wordCount(m, maskOf("LedgerEntry")!)}`);
    // method reference: LedgerEntry::getCurrency — type renamed, member kept
    check(`${g} method-ref type renamed, member kept`, m.includes(`${maskOf("LedgerEntry")!}::getCurrency`));

    // (d) NEVER-touch: stdlib + third-party + java.lang (make-or-break)
    for (const ext of [
      "BigDecimal", "List", "Map", "Collectors", "Logger", "LoggerFactory",
      "Service", "ObjectMapper", "String", "RuntimeException", "valueOf",
      "groupingBy", "counting", "stream",
    ]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external import FQNs untouched`,
      m.includes("java.math.BigDecimal") && m.includes("org.slf4j.Logger") && m.includes("com.fasterxml.jackson.databind.ObjectMapper"));

    // (e) members untouched (masking off)
    for (const member of ["reconcileBatch", "openEntries", "postEntry", "getCurrency", "getAmountMinor", "getId", "lookup", "warn"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }

    // (f) strings + secret + comments
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    // ("//" alone would false-positive on the https:// scheme in the masked URL.)
    check(`${g} comments gone`, !m.includes("/*") && !/(^|\n)\s*\/\//.test(m), "javadoc + line comments stripped");
    check(`${g} oncall channel comment gone`, !m.includes("payments-core"));
    check(`${g} javadoc body gone`, !m.includes("Walks one settlement batch") && !m.includes("Immutable summary"));

    // (g) masked output re-parses as valid Java; deterministic
    check(`${g} output re-parses clean`, (await javaParseErrors(m)) === 0);
    check(`${g} deterministic`, (await javaMasker().mask(APP_JAVA, "java")).masked === m);

    // (h) idempotency with the detector
    const r3 = await javaMasker().mask(m, "java");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (i) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const entry = maskOf("LedgerEntry")!;
    const reply = `Extract a \`BatchSummary\` from ${reconciler}, keeping ${entry}::getCurrency; class ${reconciler}Helper can wrap it.`;
    const out = rehydrate(reply, r.session);
    check(`${g} masks reversed`, out.includes("from InvoiceReconciler") && out.includes("LedgerEntry::getCurrency"));
    check(`${g} invented name passes through`, out.includes("BatchSummary"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Helper`));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "com.voltra.ledger.LedgerClient", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${real}`, round.includes(real));
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_JAVA ----
  {
    const r = await javaMasker().mask(EXTERNAL_ONLY_JAVA, "java");
    const m = r.masked;
    const g = "[java/external-only]";

    // The ONLY internal identity in the file is its own class.
    check(`${g} only own class masked`,
      r.maskedIdentifiers.length === 1 && r.maskedIdentifiers[0]!.real === "Cli",
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    for (const ext of ["Duration", "ArrayList", "List", "Logger", "LoggerFactory", "main", "isBlank", "ofSeconds"]) {
      check(`${g} "${ext}" untouched`, wordPresent(m, ext));
    }
    check(`${g} external imports byte-intact`, m.includes("import java.time.Duration;") && m.includes("import org.slf4j.LoggerFactory;"));
    check(`${g} output re-parses clean`, (await javaParseErrors(m)) === 0);
  }

  // ---- Internal WILDCARD import: conservative under-mask + index closes it ----
  {
    const g = "[java/wildcard]";
    const r = await javaMasker().mask(WILDCARD_IMPORT_JAVA, "java");
    check(`${g} wildcard import left alone`, r.masked.includes("import com.voltra.util.*;"));
    check(`${g} unresolvable Retrier NOT masked (safe under-mask)`, wordPresent(r.masked, "Retrier"));
    check(`${g} declared BatchRunner still masked`, !wordPresent(r.masked, "BatchRunner"));
    check(`${g} output re-parses clean`, (await javaParseErrors(r.masked)) === 0);

    // The project symbol index (extraInternalTypes) closes the wildcard gap.
    const masker = javaMasker();
    const r2 = await masker.mask(WILDCARD_IMPORT_JAVA, "java", new Set(["Retrier"]));
    check(`${g} index resolves Retrier -> masked`, !wordPresent(r2.masked, "Retrier"));
    check(`${g} indexed rename consistent (2 refs)`,
      wordCount(r2.masked, r2.maskedIdentifiers.find((x) => x.real === "Retrier")!.mask) === 2);
    check(`${g} System.out::println still intact`, r2.masked.includes("System.out::println"));
    check(`${g} indexed output re-parses clean`, (await javaParseErrors(r2.masked)) === 0);
  }

  // ====================================================================
  // PHASE 2 — MASKING (C#)
  // ====================================================================
  console.log("══ Phase 2: masking (csharp) ═════════════════════════════");
  const csMasker = () =>
    PolyMasker.create({ languages: ["csharp"], internalPackagePrefixes: { csharp: [...CSHARP_PREFIXES] } });
  const csParseErrors = async (code: string) => {
    const parser = await parserFor("csharp");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };
  // The C# ambiguity case: types used here but declared in OTHER files,
  // reachable only via `using Voltra.Ledger;`-style namespace imports.
  const AMBIGUOUS = ["LedgerClient", "LedgerEntry", "IFxRateProvider"];

  // ---- SNIPPET PATH (no project index): must under-mask SAFELY ----
  {
    const r = await csMasker().mask(APP_CSHARP, "csharp");
    const m = r.masked;
    const g = "[csharp/snippet]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) declared-in-file identity masked
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} namespace masked`, kindOf("Voltra.Billing") === "namespace" && !m.includes("namespace Voltra.Billing"));
    check(`${g} "InvoiceReconciler" absent`, !wordPresent(m, "InvoiceReconciler"));
    check(`${g} internal using paths masked`, !m.includes("using Voltra.Ledger;") && !m.includes("using Voltra.Billing.Fx;"));
    check(`${g} fully-qualified internal ref masked`, !m.includes("Voltra.Ledger.LedgerClient"));
    check(`${g} no "Voltra" anywhere`, !m.includes("Voltra"));

    // (b) THE C# RULE: ambiguous names (from other files, no index) are LEFT
    // ALONE — under-masked, never mismasked. They survive verbatim…
    for (const name of AMBIGUOUS) {
      check(`${g} ambiguous "${name}" left alone (no index)`, wordPresent(m, name));
      check(`${g} "${name}" not in session`, r.maskedIdentifiers.every((x) => x.real !== name));
    }

    // (c) …and so does everything external (make-or-break).
    for (const ext of [
      "HttpClient", "ILogger", "Task", "TimeSpan", "Dictionary", "IEnumerable",
      "IReadOnlyList", "HttpRequestException", "GroupBy", "ToDictionary",
      "LogWarning",
    ]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external usings byte-intact`,
      m.includes("using System.Linq;") && m.includes("using Microsoft.Extensions.Logging;") && m.includes("using Newtonsoft.Json;"));

    // (d) members untouched
    for (const member of ["ReconcileBatchAsync", "OpenEntriesAsync", "PostEntryAsync", "Lookup", "Currency", "AmountMinor"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }

    // (e) strings / secret / comments / validity
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} comments gone`, !m.includes("///") && !m.includes("payments-core") && !m.includes("Immutable summary"));
    check(`${g} output re-parses clean`, (await csParseErrors(m)) === 0);
    check(`${g} deterministic`, (await csMasker().mask(APP_CSHARP, "csharp")).masked === m);

    // (f) idempotency with the detector
    const r3 = await csMasker().mask(m, "csharp");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (g) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const reply = `Split ${reconciler} into a ${reconciler}Base and a new BatchScheduler.`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("Split InvoiceReconciler into"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Base`));
    check(`${g} invented name passes through`, out.includes("BatchScheduler"));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "using Voltra.Ledger;", "namespace Voltra.Billing", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${JSON.stringify(real)}`, round.includes(real));
    }
  }

  // ---- FILE-READ PATH (project index from a real temp project) ----
  {
    const g = "[csharp/indexed]";
    const dir = mkdtempSync(join(tmpdir(), "wyloc-csproj-"));
    try {
      writeFileSync(join(dir, "LedgerClient.cs"), SIBLING_CS);
      writeFileSync(join(dir, "InvoiceReconciler.cs"), APP_CSHARP);
      const index = new ProjectIndex(dir);
      const types = await index.internalTypes("csharp", CSHARP_PREFIXES);
      check(`${g} index finds sibling types`, AMBIGUOUS.every((n) => types.has(n)),
        `indexed: ${[...types].join(", ")}`);
      check(`${g} index has no false internals`, !types.has("HttpClient") && !types.has("Task"));

      const r = await csMasker().mask(APP_CSHARP, "csharp", types);
      const m = r.masked;
      // The ambiguity resolves: all three now masked, consistently.
      for (const name of AMBIGUOUS) {
        check(`${g} indexed "${name}" masked`, !wordPresent(m, name));
      }
      const clientMask = r.maskedIdentifiers.find((x) => x.real === "LedgerClient")!.mask;
      check(`${g} LedgerClient consistently renamed (3 refs)`, wordCount(m, clientMask) === 3,
        `got ${wordCount(m, clientMask)}`);
      // Externals STILL intact with the index on — the index adds no false internals.
      for (const ext of ["HttpClient", "ILogger", "Task", "TimeSpan"]) {
        check(`${g} external "${ext}" still present`, wordPresent(m, ext));
      }
      check(`${g} output re-parses clean`, (await csParseErrors(m)) === 0);
      const round = rehydrate(m, r.session);
      check(`${g} round-trip restores LedgerClient`, round.includes("LedgerClient"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_CSHARP (top-level program) ----
  {
    const r = await csMasker().mask(EXTERNAL_ONLY_CSHARP, "csharp");
    const g = "[csharp/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    for (const ext of ["HttpClient", "TimeSpan", "Environment", "Console", "StringSplitOptions", "Select", "ToList"]) {
      check(`${g} "${ext}" untouched`, wordPresent(r.masked, ext));
    }
    check(`${g} output re-parses clean`, (await csParseErrors(r.masked)) === 0);
  }

  // ====================================================================
  // PHASE 2 — MASKING (Kotlin)
  // ====================================================================
  console.log("══ Phase 2: masking (kotlin) ═════════════════════════════");
  const ktMasker = () =>
    PolyMasker.create({ languages: ["kotlin"], internalPackagePrefixes: { kotlin: [...KOTLIN_PREFIXES] } });
  const ktParseErrors = async (code: string) => {
    const parser = await parserFor("kotlin");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_KOTLIN (built around the grammar quirks) ----
  {
    const r = await ktMasker().mask(APP_KOTLIN, "kotlin");
    const m = r.masked;
    const g = "[kotlin/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) name-field-less declarations all extracted + classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult (data class) -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} ReconcilerRegistry (object) -> class`, kindOf("ReconcilerRegistry") === "class");
    check(`${g} BatchSummaries (typealias) -> type`, kindOf("BatchSummaries") === "type");
    check(`${g} buildReconciler (top-level fn) -> function`, kindOf("buildReconciler") === "function");
    check(`${g} package -> namespace`, kindOf("com.voltra.billing") === "namespace");

    // (b) QUIRK: import with same-line trailing comment — path rewritten
    // exactly, comment stripped, nothing mangled.
    check(`${g} trailing-comment import rewritten`, !m.includes("com.voltra.ledger.LedgerClient"));
    check(`${g} trailing comment stripped`, !m.includes("ledger service SDK"));
    check(`${g} comment after import list stripped`, !m.includes("staging swaps the host"));
    check(`${g} import line still import-shaped`, /import masked\.mod_[a-z0-9]+\.Import_[a-z0-9]+/.test(m));

    // (b') QUIRK: aliased internal import — alias binding + refs renamed
    const fxMask = maskOf("Fx");
    check(`${g} alias Fx -> import`, kindOf("Fx") === "import");
    check(`${g} alias declaration renamed`, !!fxMask && m.includes(`as ${fxMask}`));
    // 4 = import-path segment + `as` declaration + 2 type references.
    check(`${g} alias refs renamed (4 total)`, !!fxMask && wordCount(m, fxMask) === 4,
      `got ${fxMask ? wordCount(m, fxMask) : "-"}`);

    // (c) internal identity gone; consistency
    for (const real of ["InvoiceReconciler", "ReconcileResult", "LedgerClient", "LedgerEntry", "buildReconciler"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} no "voltra" anywhere`, !m.toLowerCase().includes("voltra"));
    check(`${g} InvoiceReconciler consistently renamed (5 refs)`, wordCount(m, maskOf("InvoiceReconciler")!) === 5,
      `got ${wordCount(m, maskOf("InvoiceReconciler")!)}`);

    // (d) NEVER-touch: stdlib/kotlinx/third-party (make-or-break)
    for (const ext of [
      "BigDecimal", "Dispatchers", "withContext", "LoggerFactory", "HttpClient",
      "runCatching", "groupingBy", "eachCount", "mutableListOf", "suspend",
    ]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external imports byte-intact`,
      m.includes("import kotlinx.coroutines.Dispatchers") && m.includes("import io.ktor.client.HttpClient"));

    // (e) members untouched
    for (const member of ["reconcileBatch", "openEntries", "postEntry", "currency", "amountMinor", "lookup"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }

    // (f) interpolated string: internal host masked, interpolation intact
    check(`${g} internal host masked inside interpolated string`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} \${entry.id} interpolation intact`, m.includes("${entry.id}"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} KDoc gone`, !m.includes("/**") && !m.includes("settlement batches against"));

    // (g) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await ktParseErrors(m)) === 0);
    check(`${g} deterministic`, (await ktMasker().mask(APP_KOTLIN, "kotlin")).masked === m);
    const r3 = await ktMasker().mask(m, "kotlin");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (h) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const reply = `Make ${reconciler} implement a new Closeable, add ${reconciler}Pool.`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("Make InvoiceReconciler implement"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Pool`));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "com.voltra.ledger.LedgerClient", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${real}`, round.includes(real));
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_KOTLIN ----
  {
    const r = await ktMasker().mask(EXTERNAL_ONLY_KOTLIN, "kotlin");
    const g = "[kotlin/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    for (const ext of ["Duration", "runBlocking", "LoggerFactory", "main", "getenv", "isNotEmpty"]) {
      check(`${g} "${ext}" untouched`, wordPresent(r.masked, ext));
    }
    check(`${g} output re-parses clean`, (await ktParseErrors(r.masked)) === 0);
  }

  // ====================================================================
  // PHASE 2 — MASKING (Python)
  // ====================================================================
  console.log("══ Phase 2: masking (python) ═════════════════════════════");
  const pyMasker = () =>
    PolyMasker.create({ languages: ["python"], internalPackagePrefixes: { python: [...PYTHON_PREFIXES] } });
  const pyParseErrors = async (code: string) => {
    const parser = await parserFor("python");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_PY ----
  {
    const r = await pyMasker().mask(APP_PY, "python");
    const m = r.masked;
    const g = "[python/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) declarations + import bindings classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} summarize_by_currency -> function`, kindOf("summarize_by_currency") === "function");
    check(`${g} LedgerClient (absolute internal) -> import`, kindOf("LedgerClient") === "import");
    check(`${g} LedgerEntry (relative) -> import`, kindOf("LedgerEntry") === "import");
    check(`${g} voltra_billing (module) -> namespace`, kindOf("voltra_billing") === "namespace");

    // (b) internal identity gone; module paths rewritten
    for (const real of ["InvoiceReconciler", "ReconcileResult", "LedgerClient", "LedgerEntry", "summarize_by_currency", "voltra_billing"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} relative import path masked, dot kept`, /from \.mod_[a-z0-9]+ import/.test(m));
    check(`${g} dotted module chain renamed consistently`, /mod_[a-z0-9]+\.mod_[a-z0-9]+\.lookup\(/.test(m),
      "voltra_billing.fx.lookup -> mod_h1.mod_h2.lookup");
    check(`${g} import statement matches chain refs`, (() => {
      const imp = m.match(/import (mod_[a-z0-9]+\.mod_[a-z0-9]+)\n/)?.[1];
      return !!imp && m.includes(`${imp}.lookup(`);
    })());

    // (c) NEVER-touch: stdlib + pip (make-or-break)
    for (const ext of [
      "logging", "os", "dataclass", "field", "Decimal", "Iterable", "requests",
      "retry", "stop_after_attempt", "Session", "HTTPError", "environ", "getLogger",
    ]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external imports byte-intact`,
      m.includes("from dataclasses import dataclass, field") && m.includes("from tenacity import retry, stop_after_attempt"));

    // (d) DYNAMIC-TYPING RULE: members/attributes never masked
    for (const member of ["reconcile_batch", "open_entries", "ledger_client", "currency", "amount_minor", "batch_id", "matched", "failed"]) {
      check(`${g} attribute/member "${member}" untouched`, wordPresent(m, member));
    }
    check(`${g} __init__/__name__ untouched`, m.includes("__init__") && m.includes("__name__"));

    // (e) strings / docstrings / comments / secret
    check(`${g} internal host masked (const + f-string)`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} f-string interpolation intact`, m.includes("{entry.id}"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} module docstring gone`, !m.includes("payments-core"));
    check(`${g} class/method docstrings gone`, !m.includes("Immutable summary") && !m.includes("Walks one settlement batch"));
    check(`${g} # comments gone`, !m.includes("# Internal ledger endpoint"));

    // (f) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await pyParseErrors(m)) === 0);
    check(`${g} deterministic`, (await pyMasker().mask(APP_PY, "python")).masked === m);
    const r3 = await pyMasker().mask(m, "python");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (g) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const reply = `Add a BatchQueue to ${reconciler}; subclass ${reconciler}V2 if needed.`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("to InvoiceReconciler;"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}V2`));
    check(`${g} invented name passes through`, out.includes("BatchQueue"));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "voltra_billing.ledger", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${real}`, round.includes(real));
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_PY ----
  {
    const r = await pyMasker().mask(EXTERNAL_ONLY_PY, "python");
    const g = "[python/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    for (const ext of ["json", "timedelta", "Path", "requests", "environ", "status_code"]) {
      check(`${g} "${ext}" untouched`, wordPresent(r.masked, ext));
    }
    check(`${g} public URL untouched`, r.masked.includes("https://httpbin.org/post"));
    check(`${g} output re-parses clean`, (await pyParseErrors(r.masked)) === 0);
  }

  // ====================================================================
  // PHASE 3 — REHYDRATION + ROUND-TRIP (Go)
  // ====================================================================
  console.log("══ Phase 3: rehydration (go) ═════════════════════════════");
  {
    const masker = goMasker();
    const r = await masker.mask(APP_GO, "go");
    const g = "[go/rehydrate]";
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)!.mask;

    // Simulated LLM response: uses our masks, invents its own helper, and
    // embeds a mask inside a longer invented identifier.
    const reconciler = maskOf("InvoiceReconciler");
    const fn = maskOf("NewInvoiceReconciler");
    const clientSel = maskOf("Client");
    const qual = maskOf("ledger");
    const reply = [
      `Refactor ${fn} so ${reconciler} takes a *${qual}.${clientSel} directly:`,
      "```go",
      `func makeReconciler(lc *${qual}.${clientSel}) *${reconciler} {`,
      `\treturn ${fn}(lc, nil, nil)`,
      "}",
      `type ${reconciler}Helper struct{}`,
      "```",
    ].join("\n");

    const out = rehydrate(reply, r.session);
    check(`${g} class mask reversed`, out.includes("*InvoiceReconciler {"));
    check(`${g} function mask reversed`, out.includes("InvoiceReconciler takes"));
    check(`${g} qualified selector reversed`, out.includes("ledger.Client"));
    check(`${g} invented name passes through`, out.includes("makeReconciler"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Helper`),
      "word-boundary guard must leave LLM-invented supersets alone");
    check(`${g} no masks left over`, !out.includes(reconciler.slice(0, -1) + " ") || !out.match(/Class_[a-z0-9]{6}\b/) || out.includes(`${reconciler}Helper`));

    // Secret mock round-trip
    const mock = r.swappedSecrets.find((s) => s.mock.includes("AWS"))!.mock;
    check(`${g} secret mock reverses`, rehydrate(`key is ${mock}`, r.session) === "key is AKIA5XQ2WJ8NPLR3MKVT");

    // Full-file round-trip: rehydrating the masked file restores every real
    // identifier (comments stay stripped — that's one-way by design).
    const round = rehydrate(r.masked, r.session);
    for (const real of ["InvoiceReconciler", "ReconcileResult", "NewInvoiceReconciler", "ledger.Client", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${real}`, round.includes(real));
    }
    check(`${g} round-trip has no mask residue`, !/(?:Class|Type|Interface|Enum|Mod|fn|Import|mod)_[a-z0-9]{6}/.test(round));
  }

  // ── summary ──
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
