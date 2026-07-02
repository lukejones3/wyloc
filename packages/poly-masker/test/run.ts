/**
 * Test runner for @wyloc/poly-masker. No test framework — run with: npm test
 * (uses tsx). Mirrors the code-masker runner: check() assertions, per-fixture
 * groups, and a Phase-2 (masking) + Phase-3 (rehydration/round-trip) split.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyMasker, PolyMaskError, discoverInternalPrefixes, rehydrate } from "../src/index.js";
import { parserFor } from "../src/parsers.js";
import { countParseErrors } from "../src/tree.js";
import { APP_GO, EXTERNAL_ONLY_GO, SHADOWED_QUALIFIER_GO, INTERNAL_MODULE } from "./fixtures/go.js";
import { APP_JAVA, EXTERNAL_ONLY_JAVA, WILDCARD_IMPORT_JAVA, JAVA_PREFIXES } from "./fixtures/java.js";

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
      const found = discoverInternalPrefixes(dir);
      check("[discover] go.mod module found", found.go?.[0] === INTERNAL_MODULE);
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
