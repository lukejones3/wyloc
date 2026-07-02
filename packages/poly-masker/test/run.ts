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
import { APP_COBOL, VLEDGREC_CPY, EXTERNAL_ONLY_COBOL, FREE_FORMAT_COBOL, OVERFLOW_COBOL } from "./fixtures/cobol.js";
import { APP_RUST, EXTERNAL_ONLY_RUST, RUST_PREFIXES } from "./fixtures/rust.js";
import { APP_C, VOLTRA_LEDGER_H, EXTERNAL_ONLY_C } from "./fixtures/c.js";
import { APP_CPP, VOLTRA_LEDGER_HPP, EXTERNAL_ONLY_CPP, CPP_PREFIXES } from "./fixtures/cpp.js";

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
  // PHASE 2 — MASKING (COBOL)
  // ====================================================================
  console.log("══ Phase 2: masking (cobol) ══════════════════════════════");
  const cobolMasker = () => PolyMasker.create({ languages: ["cobol"] });
  const cobolParseErrors = async (code: string) => {
    const parser = await parserFor("cobol");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };
  const cobolWord = (hay: string, w: string) =>
    new RegExp(`(?<![A-Z0-9-])${w}(?![A-Z0-9-])`).test(hay);

  // ---- Primary fixture: APP_COBOL (fixed format — column safety) ----
  {
    const r = await cobolMasker().mask(APP_COBOL, "cobol");
    const m = r.masked;
    const g = "[cobol/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) classification
    check(`${g} PROGRAM-ID -> namespace`, kindOf("VBILLRECON") === "namespace");
    check(`${g} data items -> type`, kindOf("WS-MATCHED-CNT") === "type" && kindOf("WS-LEDGER-URL") === "type");
    check(`${g} paragraph -> function`, kindOf("MAIN-PARA") === "function" && kindOf("RECONCILE-BATCH") === "function");
    check(`${g} section -> function`, kindOf("MAIN-CONTROL") === "function");
    check(`${g} COPY member -> import`, kindOf("VLEDGREC") === "import");

    // (b) SAME-LENGTH masks: valid COBOL words, exact length, never reserved
    for (const { real, mask } of r.maskedIdentifiers) {
      check(`${g} mask for ${real} same-length + valid word`,
        mask.length === real.length && /^M[A-Z0-9]*$/.test(mask), `got ${mask}`);
    }

    // (c) FIXED-FORMAT COLUMN SAFETY — the make-or-break: after filtering
    // comment lines out of the input, every line whose edits were
    // identifier-only keeps its EXACT length and its first 7 columns.
    const inLines = APP_COBOL.split("\n").filter((l) => !(l.length > 6 && (l[6] === "*" || l[6] === "/")));
    const outLines = m.split("\n");
    check(`${g} line count preserved (comments removed)`, outLines.length === inLines.length,
      `${outLines.length} vs ${inLines.length}`);
    let lenOk = true, colOk = true;
    for (let i = 0; i < Math.min(inLines.length, outLines.length); i++) {
      // string/secret masks and stripped inline *> comments legitimately
      // change a line's length; identifier renames never may.
      const lengthChanging = /WYLOC_MOCK_|host-[a-z0-9]/.test(outLines[i] ?? "") || inLines[i]!.includes("*>");
      if (!lengthChanging && outLines[i]!.length !== inLines[i]!.length) lenOk = false;
      if (outLines[i]!.slice(0, 7) !== inLines[i]!.slice(0, 7)) colOk = false;
    }
    check(`${g} identifier-only lines byte-length-identical`, lenOk);
    check(`${g} sequence area + indicator columns preserved`, colOk);
    check(`${g} no identifier-only line crosses col 72`,
      outLines.every((l) => /WYLOC_MOCK_|host-[a-z0-9]/.test(l) || l.length <= 72));

    // (d) internal identity gone, consistently
    for (const real of ["VBILLRECON", "WS-MATCHED-CNT", "WS-LEDGER-URL", "WS-BATCH-TOTALS", "MAIN-PARA", "RECONCILE-BATCH", "VLEDGREC"]) {
      check(`${g} "${real}" absent`, !cobolWord(m, real));
    }
    check(`${g} WS-MATCHED-CNT consistently renamed (4 refs)`,
      wordCount(m, maskOf("WS-MATCHED-CNT")!) === 4, `got ${wordCount(m, maskOf("WS-MATCHED-CNT")!)}`);
    check(`${g} RECONCILE-BATCH consistently renamed (2 refs)`,
      wordCount(m, maskOf("RECONCILE-BATCH")!) === 2);
    check(`${g} COPY line still copy-shaped`, /COPY M[A-Z0-9]+\./.test(m));

    // (e) NEVER-touch: verbs / figurative constants / intrinsics (make-or-break)
    for (const ext of ["PERFORM", "DISPLAY", "MOVE", "ADD", "COMPUTE", "ZERO", "FUNCTION", "NUMVAL", "GREATER", "END-IF", "PIC", "VALUE", "STOP"]) {
      check(`${g} reserved "${ext}" still present`, cobolWord(m, ext));
      check(`${g} reserved "${ext}" never in session`, r.maskedIdentifiers.every((x) => x.real.toUpperCase() !== ext));
    }

    // (f) copybook-sourced name on the SNIPPET path: left alone (safe under-mask)
    check(`${g} VL-RATE-RAW (copybook, no index) left alone`, cobolWord(m, "VL-RATE-RAW"));

    // (g) strings / secret / comments
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} col-7 comment lines gone`, !m.includes("PROPRIETARY") && !m.includes("PAYMENTS-CORE"));
    check(`${g} inline *> comment stripped, statement kept`, !m.includes("per settlement batch") && /PERFORM M[A-Z0-9]+\s*$/m.test(m));

    // (h) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await cobolParseErrors(m)) === 0);
    check(`${g} deterministic`, (await cobolMasker().mask(APP_COBOL, "cobol")).masked === m);
    const r3 = await cobolMasker().mask(m, "cobol");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (i) rehydration round-trip incl. invented identifiers
    const cnt = maskOf("WS-MATCHED-CNT")!;
    const para = maskOf("RECONCILE-BATCH")!;
    const reply = `Add a new paragraph AUDIT-PARA after ${para}; move ${cnt} into a group item.`;
    const out = rehydrate(reply, r.session);
    check(`${g} masks reversed`, out.includes("after RECONCILE-BATCH") && out.includes("move WS-MATCHED-CNT"));
    check(`${g} invented name passes through`, out.includes("AUDIT-PARA"));
    const round = rehydrate(m, r.session);
    for (const real of ["VBILLRECON", "WS-MATCHED-CNT", "COPY VLEDGREC", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${real}`, round.includes(real));
    }
  }

  // ---- FILE-READ PATH: copybook via the project index ----
  {
    const g = "[cobol/copybook-indexed]";
    const dir = mkdtempSync(join(tmpdir(), "wyloc-cbl-"));
    try {
      writeFileSync(join(dir, "VLEDGREC.cpy"), VLEDGREC_CPY);
      const index = new ProjectIndex(dir);
      const types = await index.internalTypes("cobol", []);
      check(`${g} copybook data items indexed`,
        ["VL-ENTRY", "VL-ENTRY-ID", "VL-CURRENCY", "VL-AMT-MINOR", "VL-RATE-RAW"].every((n) => types.has(n)),
        `indexed: ${[...types].join(", ")}`);
      const r = await cobolMasker().mask(APP_COBOL, "cobol", types);
      check(`${g} VL-RATE-RAW now masked`, !cobolWord(r.masked, "VL-RATE-RAW"));
      const target = r.maskedIdentifiers.find((x) => x.real === "VL-RATE-RAW")!;
      check(`${g} same-length mask for copybook item`, target.mask.length === "VL-RATE-RAW".length);
      check(`${g} output re-parses clean`, (await cobolParseErrors(r.masked)) === 0);
      check(`${g} round-trip restores VL-RATE-RAW`, rehydrate(r.masked, r.session).includes("VL-RATE-RAW"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_COBOL ----
  {
    const r = await cobolMasker().mask(EXTERNAL_ONLY_COBOL, "cobol");
    const g = "[cobol/external-only]";
    const maskedReals = r.maskedIdentifiers.map((x) => x.real).sort();
    // Only the program's OWN identity (program-id + its one paragraph).
    check(`${g} only own identity masked`, maskedReals.join(",") === "MAINPROG,ONLY-PARA",
      `masked: ${maskedReals.join(", ")}`);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    for (const ext of ["DISPLAY", "FUNCTION", "CURRENT-DATE", "UPPER-CASE", "STOP", "RUN"]) {
      check(`${g} "${ext}" untouched`, cobolWord(r.masked, ext));
    }
    check(`${g} output re-parses clean`, (await cobolParseErrors(r.masked)) === 0);
  }

  // ---- Column-72 OVERFLOW: documented, contained behavior ----
  {
    const g = "[cobol/col72-overflow]";
    const r = await cobolMasker().mask(OVERFLOW_COBOL, "cobol");
    check(`${g} mask still succeeds (identifier rewrite gate is pre-detector)`, r.masked.length > 0);
    check(`${g} secret swapped despite overflow`, !r.masked.includes("AKIA5XQ2WJ8NPLR3MKVT") && r.masked.includes("WYLOC_MOCK_"));
    const overLines = r.masked.split("\n").filter((l) => l.length > 72);
    check(`${g} exactly the mock line crosses col 72`, overLines.length === 1 && overLines[0]!.includes("WYLOC_MOCK_"));
    // the error island is contained: identifiers everywhere else still masked
    check(`${g} program identity still masked`, !cobolWord(r.masked, "VOVERFLOW") && !cobolWord(r.masked, "WS-SECRET-KEY-FLD"));
    check(`${g} round-trip restores the original line`, rehydrate(r.masked, r.session).includes('VALUE "AKIA5XQ2WJ8NPLR3MKVT"'));
  }

  // ---- FREE-FORMAT source: grammar limitation, degrades safely ----
  // The COBOL85 grammar expects fixed/area-formatted source; true column-1
  // free format fails the input parse gate → detector-only fallback (the
  // caller keeps the text unchanged and secrets still get scrubbed there).
  {
    const g = "[cobol/free-format]";
    let threw = false;
    try {
      await cobolMasker().mask(FREE_FORMAT_COBOL, "cobol");
    } catch (e) {
      threw = e instanceof PolyMaskError;
    }
    check(`${g} column-1 free format degrades via PolyMaskError (documented)`, threw);
  }

  // ====================================================================
  // PHASE 2 — MASKING (Rust)
  // ====================================================================
  console.log("══ Phase 2: masking (rust) ═══════════════════════════════");
  const rustMasker = () =>
    PolyMasker.create({ languages: ["rust"], internalPackagePrefixes: { rust: [...RUST_PREFIXES] } });
  const rustParseErrors = async (code: string) => {
    const parser = await parserFor("rust");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_RUST ----
  {
    const r = await rustMasker().mask(APP_RUST, "rust");
    const m = r.masked;
    const g = "[rust/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) declarations + use bindings classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileOutcome -> enum`, kindOf("ReconcileOutcome") === "enum");
    check(`${g} Retryable -> interface`, kindOf("Retryable") === "interface");
    check(`${g} BatchSummaries -> type`, kindOf("BatchSummaries") === "type");
    check(`${g} mod dunning -> namespace`, kindOf("dunning") === "namespace");
    check(`${g} reconcile_batch -> function`, kindOf("reconcile_batch") === "function");
    check(`${g} voltra_audit (macro) -> function`, kindOf("voltra_audit") === "function");
    check(`${g} LedgerClient (crate::) -> import`, kindOf("LedgerClient") === "import");
    check(`${g} FxRateProvider + RateWindow (use list) -> import`,
      kindOf("FxRateProvider") === "import" && kindOf("RateWindow") === "import");
    check(`${g} Sink (as-alias) -> import`, kindOf("Sink") === "import");

    // (b) internal identity gone from CODE; the one mention inside a macro
    // STRING survives by design (macro conservatism — it's literal text).
    for (const real of ["ReconcileOutcome", "Retryable", "BatchSummaries", "reconcile_batch", "LedgerClient", "FxRateProvider", "RateWindow"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} InvoiceReconciler only survives inside the macro string`,
      wordCount(m, "InvoiceReconciler") === 1 && m.includes("InvoiceReconciler pending"),
      `count=${wordCount(m, "InvoiceReconciler")}`);
    check(`${g} internal use paths rewritten`, !m.includes("crate::ledger") && !m.includes("crate::fx") && /use crate::mod_[a-z0-9]+::Import_[a-z0-9]+;/.test(m));

    // (c) MACRO CONSERVATISM (the Tier-2 rule)
    // - the macro's own name renamed at definition AND call site
    const macroMask = maskOf("voltra_audit")!;
    check(`${g} macro_rules! name renamed`, m.includes(`macro_rules! ${macroMask}`));
    check(`${g} macro call site renamed`, m.includes(`${macroMask}!(batch_id)`));
    // - the argument INSIDE the bang untouched (token_tree)
    check(`${g} token-tree arg untouched`, m.includes("!(batch_id)"));
    // - a target name inside a println! STRING untouched (it's literal text)
    check(`${g} name inside macro string untouched`, m.includes("InvoiceReconciler pending"));
    // - derive attribute untouched
    check(`${g} #[derive(...)] untouched`, m.includes("#[derive(Debug, Serialize, Deserialize)]"));

    // (d) NEVER-touch: std + external crates (make-or-break)
    for (const ext of ["HashMap", "Duration", "Serialize", "Deserialize", "sleep", "String", "default", "println"]) {
      check(`${g} external "${ext}" still present`, wordPresent(m, ext));
    }
    check(`${g} external uses byte-intact`,
      m.includes("use std::collections::HashMap;") && m.includes("use serde::{Deserialize, Serialize};") && m.includes("use tokio::time::sleep;"));

    // (e) members untouched (impl methods, fields, enum variants)
    for (const member of ["summarize", "open_entries", "lookup", "record", "matched", "failed", "currency", "Matched", "Failed", "retry"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }

    // (f) strings / secret / comments
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} doc + line comments gone`, !m.includes("Proprietary") && !m.includes("payments-core") && !m.includes("members untouched:"));

    // (g) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await rustParseErrors(m)) === 0);
    check(`${g} deterministic`, (await rustMasker().mask(APP_RUST, "rust")).masked === m);
    const r3 = await rustMasker().mask(m, "rust");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (h) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const reply = `Wrap ${reconciler} in an Arc; a ${reconciler}Pool and try_reconcile() would help.`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("Wrap InvoiceReconciler in an Arc"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Pool`));
    check(`${g} invented name passes through`, out.includes("try_reconcile"));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "crate::ledger", "voltra_audit!(batch_id)", "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${JSON.stringify(real)}`, round.includes(real));
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_RUST ----
  {
    const r = await rustMasker().mask(EXTERNAL_ONLY_RUST, "rust");
    const g = "[rust/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    check(`${g} fn main kept (entrypoint)`, r.masked.includes("fn main()"));
    for (const ext of ["HashMap", "Duration", "from_secs", "unwrap_or_default", "println"]) {
      check(`${g} "${ext}" untouched`, wordPresent(r.masked, ext));
    }
    check(`${g} output re-parses clean`, (await rustParseErrors(r.masked)) === 0);
  }

  // ====================================================================
  // PHASE 2 — MASKING (C)
  // ====================================================================
  console.log("══ Phase 2: masking (c) ══════════════════════════════════");
  const cMasker = () => PolyMasker.create({ languages: ["c"] });
  const cParseErrors = async (code: string) => {
    const parser = await parserFor("c");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_C ----
  {
    const r = await cMasker().mask(APP_C, "c");
    const m = r.masked;
    const g = "[c/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) declarations classified
    check(`${g} struct tag -> type`, kindOf("invoice_reconciler") === "type");
    check(`${g} typedef -> type`, kindOf("invoice_reconciler_t") === "type");
    check(`${g} enum tag -> type`, kindOf("reconcile_outcome") === "type");
    check(`${g} static fn -> function`, kindOf("reconcile_entry") === "function");
    check(`${g} extern fn -> function`, kindOf("reconcile_batch") === "function");

    // (b) internal identity gone; local include path masked
    for (const real of ["invoice_reconciler", "invoice_reconciler_t", "reconcile_entry", "reconcile_batch"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} local include path masked`, !m.includes("voltra_ledger.h") && /#include "masked_mod_[a-z0-9]+\.h"/.test(m));
    check(`${g} reconcile_entry consistently renamed (3 refs)`, wordCount(m, maskOf("reconcile_entry")!) === 3,
      `got ${wordCount(m, maskOf("reconcile_entry")!)}`);

    // (c) PREPROCESSOR CONSERVATISM (the Tier-2 rule)
    check(`${g} #define MAX_BATCH untouched`, m.includes("#define MAX_BATCH 512") && wordCount(m, "MAX_BATCH") === 4);
    check(`${g} #define POST_ENTRY untouched`, m.includes("#define POST_ENTRY(id, amt)"));
    check(`${g} macro-body name ledger_post untouched`, wordPresent(m, "ledger_post"));
    check(`${g} #if condition untouched`, m.includes("#if MAX_BATCH > 256"));
    check(`${g} POST_ENTRY call site untouched`, m.includes("POST_ENTRY("));
    // snippet path: header names unresolvable without the index — left alone
    check(`${g} header fn left alone (no index)`, wordPresent(m, "ledger_open_entries"));
    // enum CONSTANTS are members (off)
    check(`${g} enum constants untouched`, wordPresent(m, "RECONCILE_OK") && wordPresent(m, "RECONCILE_FAIL"));

    // (d) NEVER-touch: stdlib/system (make-or-break)
    for (const ext of ["printf", "memset", "size_t", "sizeof", "stdio", "stdlib", "string"]) {
      check(`${g} external "${ext}" still present`, m.includes(ext));
    }
    check(`${g} system includes byte-intact`, m.includes("#include <stdio.h>") && m.includes("#include <string.h>"));

    // (e) strings / secret / comments (strings INSIDE macro bodies still masked —
    // substring ops are safe; only identifier renames are macro-gated)
    check(`${g} internal host masked (inside #define string)`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} comments gone`, !m.includes("Proprietary") && !m.includes("payments-core"));

    // (f) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await cParseErrors(m)) === 0);
    check(`${g} deterministic`, (await cMasker().mask(APP_C, "c")).masked === m);
    const r3 = await cMasker().mask(m, "c");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (g) rehydration round-trip incl. invented identifiers
    const recMask = maskOf("invoice_reconciler_t")!;
    const reply = `Split ${recMask} into a ${recMask}_view and add batch_stats_t.`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("Split invoice_reconciler_t into"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${recMask}_view`));
    check(`${g} invented name passes through`, out.includes("batch_stats_t"));
    const round = rehydrate(m, r.session);
    for (const real of ["invoice_reconciler_t", "reconcile_batch", '#include "voltra_ledger.h"', "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${JSON.stringify(real)}`, round.includes(real));
    }
  }

  // ---- FILE-READ PATH: local header via the project index ----
  {
    const g = "[c/header-indexed]";
    const dir = mkdtempSync(join(tmpdir(), "wyloc-c-"));
    try {
      writeFileSync(join(dir, "voltra_ledger.h"), VOLTRA_LEDGER_H);
      const index = new ProjectIndex(dir);
      const types = await index.internalTypes("c", []);
      check(`${g} header prototypes + types indexed`,
        ["ledger_open_entries", "ledger_post", "ledger_entry", "ledger_entry_t"].every((n) => types.has(n)),
        `indexed: ${[...types].join(", ")}`);
      check(`${g} header guard #define NOT indexed`, !types.has("VOLTRA_LEDGER_H"));

      const r = await cMasker().mask(APP_C, "c", types);
      check(`${g} header fn now masked`, !wordPresent(r.masked, "ledger_open_entries"));
      // conservatism BEATS the index: ledger_post only occurs inside a #define
      // body, so it stays untouched even though the index knows it's internal.
      check(`${g} macro-body name still untouched despite index`, wordPresent(r.masked, "ledger_post"));
      check(`${g} output re-parses clean`, (await cParseErrors(r.masked)) === 0);
      check(`${g} round-trip restores header fn`, rehydrate(r.masked, r.session).includes("ledger_open_entries"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_C ----
  {
    const r = await cMasker().mask(EXTERNAL_ONLY_C, "c");
    const g = "[c/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    check(`${g} main kept (entrypoint)`, r.masked.includes("int main(int argc"));
    for (const ext of ["getenv", "strncpy", "strtok", "strlen", "printf", "EXIT_SUCCESS"]) {
      check(`${g} "${ext}" untouched`, wordPresent(r.masked, ext));
    }
    check(`${g} output re-parses clean`, (await cParseErrors(r.masked)) === 0);
  }

  // ====================================================================
  // PHASE 2 — MASKING (C++)
  // ====================================================================
  console.log("══ Phase 2: masking (cpp) ════════════════════════════════");
  const cppMasker = () =>
    PolyMasker.create({ languages: ["cpp"], internalPackagePrefixes: { cpp: [...CPP_PREFIXES] } });
  const cppParseErrors = async (code: string) => {
    const parser = await parserFor("cpp");
    const tree = parser.parse(code);
    return tree ? countParseErrors(tree.rootNode) : Infinity;
  };

  // ---- Primary fixture: APP_CPP ----
  {
    const r = await cppMasker().mask(APP_CPP, "cpp");
    const m = r.masked;
    const g = "[cpp/app]";
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    const maskOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.mask;

    // (a) declarations + namespace classified
    check(`${g} InvoiceReconciler -> class`, kindOf("InvoiceReconciler") === "class");
    check(`${g} ReconcileResult -> class`, kindOf("ReconcileResult") === "class");
    check(`${g} BatchSummaries (alias) -> type`, kindOf("BatchSummaries") === "type");
    check(`${g} run_batch -> function`, kindOf("run_batch") === "function");
    check(`${g} namespace masked (config-gated)`, !m.includes("namespace voltra::billing") && /namespace masked_ns_[a-z0-9]+/.test(m));

    // (b) internal identity gone; local include masked; FQ ref rewritten
    for (const real of ["InvoiceReconciler", "ReconcileResult", "BatchSummaries", "run_batch"]) {
      check(`${g} "${real}" absent`, !wordPresent(m, real));
    }
    check(`${g} local include path masked`, !m.includes("voltra/ledger_client.hpp") && /#include "masked_mod_[a-z0-9]+\.hpp"/.test(m));
    check(`${g} fully-qualified internal ref rewritten`, !m.includes("voltra::billing::InvoiceReconciler") && /masked_ns_[a-z0-9]+::Class_[a-z0-9]+/.test(m));

    // (c) CONSERVATISM: preprocessor + templates + members
    check(`${g} #define VOLTRA_AUDIT untouched`, m.includes("#define VOLTRA_AUDIT(msg)"));
    check(`${g} macro call site untouched`, m.includes('VOLTRA_AUDIT("batch start")'));
    check(`${g} template parameter untouched`, m.includes("template <typename Range>"));
    // members: methods (incl. out-of-class definition), fields
    for (const member of ["summarize", "reconcile", "post_entry", "client_", "matched", "failed", "currency"]) {
      check(`${g} member "${member}" untouched`, wordPresent(m, member));
    }
    // snippet path: header class unresolvable without index — left alone
    check(`${g} header class left alone (no index)`, wordPresent(m, "LedgerClient"));

    // (d) NEVER-touch: std / system (make-or-break)
    for (const ext of ["std::map", "std::string", "std::vector", "std::shared_ptr", "std::move", "std::make_shared", "std::fprintf", "static_cast"]) {
      check(`${g} external "${ext}" still present`, m.includes(ext));
    }
    check(`${g} system includes byte-intact`, m.includes("#include <map>") && m.includes("#include <memory>"));

    // (e) strings / secret / comments
    check(`${g} internal host masked`, !m.includes("ledger.internal.voltra.io"));
    check(`${g} AWS key swapped`, !m.includes("AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} comments gone`, !m.includes("Proprietary") && !m.includes("payments-core") && !m.includes("MEMBER, stays untouched"));

    // (f) validity + determinism + idempotency
    check(`${g} output re-parses clean`, (await cppParseErrors(m)) === 0);
    check(`${g} deterministic`, (await cppMasker().mask(APP_CPP, "cpp")).masked === m);
    const r3 = await cppMasker().mask(m, "cpp");
    for (const { mock } of r.swappedSecrets) {
      check(`${g} idempotent: ${mock.slice(0, 22)}… survives`, r3.masked.includes(mock));
    }
    check(`${g} idempotent: no new secret swap`, r3.swappedSecrets.length === 0);

    // (g) rehydration round-trip incl. invented identifiers
    const reconciler = maskOf("InvoiceReconciler")!;
    const reply = `Make ${reconciler} movable; add a ${reconciler}Builder and batch_pool().`;
    const out = rehydrate(reply, r.session);
    check(`${g} mask reversed`, out.includes("Make InvoiceReconciler movable"));
    check(`${g} embedded mask NOT reversed`, out.includes(`${reconciler}Builder`));
    check(`${g} invented name passes through`, out.includes("batch_pool"));
    const round = rehydrate(m, r.session);
    for (const real of ["InvoiceReconciler", "namespace voltra::billing", '#include "voltra/ledger_client.hpp"', "ledger.internal.voltra.io", "AKIA5XQ2WJ8NPLR3MKVT"]) {
      check(`${g} round-trip restores ${JSON.stringify(real)}`, round.includes(real));
    }
  }

  // ---- FILE-READ PATH: local .hpp via the project index ----
  {
    const g = "[cpp/header-indexed]";
    const dir = mkdtempSync(join(tmpdir(), "wyloc-cpp-"));
    try {
      writeFileSync(join(dir, "ledger_client.hpp"), VOLTRA_LEDGER_HPP);
      const index = new ProjectIndex(dir);
      const types = await index.internalTypes("cpp", CPP_PREFIXES);
      check(`${g} header class indexed`, types.has("LedgerClient"), `indexed: ${[...types].join(", ")}`);
      const r = await cppMasker().mask(APP_CPP, "cpp", types);
      check(`${g} LedgerClient now masked`, !wordPresent(r.masked, "LedgerClient"));
      check(`${g} std types STILL intact with index on`, r.masked.includes("std::shared_ptr") && r.masked.includes("std::vector"));
      check(`${g} output re-parses clean`, (await cppParseErrors(r.masked)) === 0);
      check(`${g} round-trip restores LedgerClient`, rehydrate(r.masked, r.session).includes("LedgerClient"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- NEGATIVE fixture: EXTERNAL_ONLY_CPP ----
  {
    const r = await cppMasker().mask(EXTERNAL_ONLY_CPP, "cpp");
    const g = "[cpp/external-only]";
    check(`${g} zero identifiers masked`, r.maskedIdentifiers.length === 0,
      `masked: ${r.maskedIdentifiers.map((x) => x.real).join(", ")}`);
    check(`${g} zero module specifiers masked`, r.maskedModuleSpecifiers.length === 0);
    check(`${g} zero strings masked`, r.maskedStrings.length === 0);
    check(`${g} zero secrets`, r.swappedSecrets.length === 0);
    check(`${g} main kept (entrypoint)`, r.masked.includes("int main()"));
    for (const ext of ["std::getenv", "std::vector", "std::stringstream", "std::getline", "std::cout", "EXIT_SUCCESS"]) {
      check(`${g} "${ext}" untouched`, r.masked.includes(ext));
    }
    check(`${g} output re-parses clean`, (await cppParseErrors(r.masked)) === 0);
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
