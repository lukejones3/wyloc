/**
 * Test runner for @wyloc/code-masker. No test framework — run with: npm test
 * (uses tsx).
 *
 * Phase 2 verifies masking + classification + comment stripping + regen
 * validity. Phase 3 (rehydration + round-trip) is added in the next phase.
 */
import ts from "typescript";
import { CodeMasker, resolveConfig } from "../src/index.js";
import { APP_TS, EXTERNAL_ONLY_TS, MEMBERS_TS, MEMBERS_GATED_TS, MEMBERS_ELEMENT_TS, TEMPLATE_TS } from "./fixtures/samples.js";

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

const has = (hay: string, needle: string) => hay.includes(needle);
const wordPresent = (hay: string, w: string) =>
  new RegExp(`(?<![A-Za-z0-9_$])${w}(?![A-Za-z0-9_$])`).test(hay);

/** Re-parse masked output and count parse errors — proves it's still valid TS. */
function parseErrors(code: string): number {
  const sf = ts.createSourceFile("out.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length;
}

function main(): void {
  // ====================================================================
  // PHASE 2 — MASKING
  // ====================================================================
  console.log("\n══ Phase 2: masking ══════════════════════════════════════");

  // ---- Primary fixture: APP_TS (default config) ----
  {
    const masker = CodeMasker.create();
    const r = masker.mask(APP_TS, "app.ts");
    const m = r.masked;
    const g = "[app]";

    // (a) internal class/function/interface/type/enum masked + classified
    const kindOf = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)?.kind;
    check(`${g} BillingReconciler -> class`, kindOf("BillingReconciler") === "class");
    check(`${g} bootstrap -> function`, kindOf("bootstrap") === "function");
    check(`${g} useDunning -> function`, kindOf("useDunning") === "function");
    check(`${g} LedgerEntry -> interface`, kindOf("LedgerEntry") === "interface");
    check(`${g} DunningState -> type`, kindOf("DunningState") === "type");
    check(`${g} InvoiceStatus -> enum`, kindOf("InvoiceStatus") === "enum");
    check(`${g} LedgerStore -> import`, kindOf("LedgerStore") === "import");
    check(`${g} formatMoney -> import`, kindOf("formatMoney") === "import");

    // (a) real proprietary names GONE from output
    for (const real of [
      "BillingReconciler", "bootstrap", "useDunning", "LedgerEntry",
      "DunningState", "InvoiceStatus", "LedgerStore", "formatMoney",
    ]) {
      check(`${g} '${real}' absent from masked code`, !wordPresent(m, real));
    }

    // (a) consistency: every reference renamed to the SAME mask
    const reconcilerMask = r.maskedIdentifiers.find((x) => x.real === "BillingReconciler")!.mask;
    // class decl + 2 `new` + return type annotation = >=3 occurrences
    const occ = (m.match(new RegExp(reconcilerMask, "g")) ?? []).length;
    check(`${g} BillingReconciler mask used consistently (>=3x)`, occ >= 3, `saw ${occ}`);

    // module specifiers masked
    check(`${g} './ledger/store' specifier masked`, !has(m, "./ledger/store"));
    check(`${g} '../util/money' specifier masked`, !has(m, "../util/money"));

    // (b) external / library identifiers NEVER masked — the make-or-break rule
    for (const ext of ["useState", "useEffect", "randomBytes", "sumBy"]) {
      check(`${g} external '${ext}' preserved`, wordPresent(m, ext));
    }
    check(`${g} lodash import 'from "lodash"' preserved`, has(m, `"lodash"`));
    check(`${g} react import 'from "react"' preserved`, has(m, `"react"`));
    check(`${g} 'node:crypto' import preserved`, has(m, `"node:crypto"`));
    check(
      `${g} no external name in maskedIdentifiers`,
      !r.maskedIdentifiers.some((x) =>
        ["useState", "useEffect", "randomBytes", "_", "sumBy"].includes(x.real),
      ),
    );

    // (c) internal URLs / hosts / IPs / paths masked
    for (const real of [
      "billing.internal.acme.com", "ledger-primary.corp", "10.4.12.9",
      "/Users/svc-billing/secrets/app.json",
    ]) {
      check(`${g} internal infra '${real}' masked`, !has(m, real));
    }
    check(`${g} URL scheme/path shape preserved`, has(m, "https://") && has(m, "/v2/reconcile"));

    // (d) hardcoded secret swapped via detector
    check(`${g} AWS key swapped`, !has(m, "AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} a secret swap was recorded`, r.swappedSecrets.length >= 1);

    // (e) comments stripped wholesale
    for (const frag of ["Proprietary billing engine", "Project Northstar", "dunning state machine", "wires the proprietary"]) {
      check(`${g} comment '${frag.slice(0, 18)}…' stripped`, !has(m, frag));
    }
    // `://` in URLs is not a comment — exclude it.
    check(`${g} no // line comments remain`, !/(?<!:)\/\/[ \t]*\w/.test(m));
    check(`${g} no /* block comments remain`, !/\/\*/.test(m));

    // (f) generic locals + keywords + business strings untouched
    for (const local of ["total", "salt", "display", "state", "entries"]) {
      check(`${g} local '${local}' preserved`, wordPresent(m, local));
    }
    for (const kw of ["export", "const", "return", "class", "function"]) {
      check(`${g} keyword '${kw}' preserved`, wordPresent(m, kw));
    }
    check(`${g} business-logic string '"overdue"' preserved`, has(m, `"overdue"`));

    // (h) regenerated code is still valid TS
    check(`${g} masked output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ---- Negative fixture: EXTERNAL_ONLY_TS (the correctness check) ----
  {
    const r = CodeMasker.create().mask(EXTERNAL_ONLY_TS, "ext.ts");
    const m = r.masked;
    const g = "[external-only]";

    const externals = [
      "useState", "useEffect", "useMemo", "useCallback",
      "z", "debounce", "throttle", "cloneDeep", "readFile", "Buffer",
    ];
    for (const ext of externals) {
      check(`${g} '${ext}' survives verbatim`, wordPresent(m, ext));
    }
    check(
      `${g} NO external/library identifier was masked`,
      !r.maskedIdentifiers.some((x) => externals.includes(x.real)),
      JSON.stringify(r.maskedIdentifiers.filter((x) => externals.includes(x.real))),
    );
    check(`${g} no internal-infra false positives`, r.maskedStrings.length === 0,
      JSON.stringify(r.maskedStrings));
    check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ---- Opt-in member masking: MEMBERS_TS ----
  {
    const cfg = resolveConfig({ maskMembers: true });
    const r = new CodeMasker(cfg).mask(MEMBERS_TS, "members.ts");
    const m = r.masked;
    const g = "[members]";

    check(`${g} method 'score' masked`, r.maskedIdentifiers.some((x) => x.real === "score" && x.kind === "member"));
    check(`${g} property 'weight' masked`, r.maskedIdentifiers.some((x) => x.real === "weight" && x.kind === "member"));
    // member name gone from BOTH declaration and the well-typed access site
    check(`${g} 'score' absent (decl + access)`, !wordPresent(m, "score"));
    check(`${g} 'weight' absent (decl + access)`, !wordPresent(m, "weight"));
    // business logic intact, output valid
    check(`${g} 'input * ' logic preserved`, has(m, "input *"));
    check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ---- (a) all-resolvable member masked at EVERY site ----
  {
    const r = new CodeMasker(resolveConfig({ maskMembers: true })).mask(MEMBERS_TS, "members.ts");
    const g = "[members:resolvable]";
    // 'weight' appears as decl + this.weight + (param 'w' is a different symbol).
    // Every occurrence of the member name is gone — no partial masking remains.
    check(`${g} 'weight' fully masked (0 occurrences left)`, (r.masked.match(/\bweight\b/g) ?? []).length === 0);
    check(`${g} 'score' fully masked (0 occurrences left)`, (r.masked.match(/\bscore\b/g) ?? []).length === 0);
  }

  // ---- (a') resolvable element-access member is masked, string included ----
  {
    const r = new CodeMasker(resolveConfig({ maskMembers: true })).mask(MEMBERS_ELEMENT_TS, "el.ts");
    const m = r.masked;
    const g = "[members:element]";
    check(`${g} 'level' masked as member`, r.maskedIdentifiers.some((x) => x.real === "level" && x.kind === "member"));
    check(`${g} 'rotate' masked as member`, r.maskedIdentifiers.some((x) => x.real === "rotate" && x.kind === "member"));
    // gone from BOTH the declaration AND the v["level"] computed access string
    check(`${g} 'level' absent everywhere (decl + element access)`, !wordPresent(m, "level"));
    check(`${g} no leftover '["level"]'`, !has(m, '"level"'));
    check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ---- (b) member with an any-typed access site is left COMPLETELY untouched ----
  {
    const r = new CodeMasker(resolveConfig({ maskMembers: true })).mask(MEMBERS_GATED_TS, "gated.ts");
    const m = r.masked;
    const g = "[members:gated]";
    // 'emit' has an any-typed call site -> must NOT be masked anywhere.
    check(`${g} 'emit' NOT masked (unresolvable any-site)`, !r.maskedIdentifiers.some((x) => x.real === "emit"));
    // present at all original sites: declaration + 2 call sites = 3 occurrences.
    check(`${g} 'emit' preserved at all 3 sites (no partial masking)`,
      (m.match(/\bemit\b/g) ?? []).length === 3, `${(m.match(/\bemit\b/g) ?? []).length} occurrences`);
    // selectivity: a fully-resolvable member on the SAME class IS still masked.
    check(`${g} 'count' (all-resolvable) masked`, r.maskedIdentifiers.some((x) => x.real === "count" && x.kind === "member"));
    check(`${g} 'count' absent everywhere`, !wordPresent(m, "count"));
    check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ---- Real repo file as a real-shaped fixture ----
  {
    const src = ts.sys.readFile(new URL("../../gateway/src/session.ts", import.meta.url).pathname);
    if (src) {
      const r = CodeMasker.create().mask(src, "session.ts");
      const m = r.masked;
      const g = "[real:gateway/session.ts]";
      check(`${g} SessionStore (internal class) masked`, !wordPresent(m, "SessionStore"));
      check(`${g} randomBytes (node import) preserved`, wordPresent(m, "randomBytes"));
      check(`${g} SwapMapping (external @wyloc import) preserved`, wordPresent(m, "SwapMapping"));
      check(`${g} comments stripped`, !/\/\*/.test(m) && !has(m, "PRIVACY CONTRACT"));
      check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
    } else {
      check("[real] gateway/session.ts readable", false, "could not read fixture");
    }
  }

  // ---- Template literal with ${} substitution (Phase 3 gap closed) ----
  {
    const r = CodeMasker.create().mask(TEMPLATE_TS, "tpl.ts");
    const m = r.masked;
    const g = "[template]";
    check(`${g} internal host in template head masked`, !has(m, "billing.internal.acme.com"));
    check(`${g} internal host in template tail masked`, !has(m, "ledger-primary.corp"));
    check(`${g} substitution \${path} preserved`, has(m, "${path}"));
    check(`${g} substitution \${port} preserved`, has(m, "${port}"));
    check(`${g} URL shape preserved`, has(m, "https://") && has(m, "/v2/"));
    check(`${g} output parses (0 errors)`, parseErrors(m) === 0, `${parseErrors(m)} errors`);
  }

  // ====================================================================
  // PHASE 3 — REHYDRATION + ROUND-TRIP
  // ====================================================================
  console.log("\n══ Phase 3: rehydration ══════════════════════════════════");

  {
    const masker = CodeMasker.create();
    const r = masker.mask(APP_TS, "app.ts");
    const g = "[round-trip]";

    const maskFor = (real: string) => r.maskedIdentifiers.find((x) => x.real === real)!.mask;
    const reconcilerMask = maskFor("BillingReconciler");
    const storeMask = maskFor("LedgerStore");
    const secretMock = r.swappedSecrets[0]!.mock;

    // Simulate an LLM reply: it references our masks, INVENTS new names
    // (`makeReconciler`, `InvoiceHelper`, `helper`), embeds a mask inside an
    // invented identifier (`<mask>Factory`), and echoes the swapped secret.
    const llmReply = [
      `function makeReconciler(): ${reconcilerMask} {`,
      `  const helper = new InvoiceHelper();`,
      `  const f: ${reconcilerMask}Factory = buildFactory();`,
      `  return new ${reconcilerMask}(new ${storeMask}());`,
      `}`,
      `// key for local dev: ${secretMock}`,
    ].join("\n");

    const restored = masker.rehydrate(llmReply, r.session);

    // (g) known tokens reversed
    check(`${g} BillingReconciler restored`, wordPresent(restored, "BillingReconciler"));
    check(`${g} LedgerStore restored`, wordPresent(restored, "LedgerStore"));
    check(`${g} secret restored`, has(restored, "AKIA5XQ2WJ8NPLR3MKVT"));
    check(`${g} no reconciler mask left`, !wordPresent(restored, reconcilerMask));
    check(`${g} no store mask left`, !has(restored, storeMask));
    check(`${g} no secret mock left`, !has(restored, secretMock));

    // (g) LLM-invented identifiers passed through untouched
    check(`${g} invented 'makeReconciler' passed through`, wordPresent(restored, "makeReconciler"));
    check(`${g} invented 'InvoiceHelper' passed through`, wordPresent(restored, "InvoiceHelper"));
    check(`${g} invented 'helper' passed through`, wordPresent(restored, "helper"));
    // word-boundary safety: a mask embedded in an invented identifier is NOT reversed
    check(`${g} '<mask>Factory' not corrupted`, has(restored, `${reconcilerMask}Factory`));

    // idempotence on text with nothing to reverse
    check(`${g} rehydrate is a no-op on clean text`,
      masker.rehydrate("const x = plainCode();", r.session) === "const x = plainCode();");
  }

  // round-trip on internal infra masks (string/host/path/ip) inside a reply
  {
    const masker = CodeMasker.create();
    const r = masker.mask(APP_TS, "app.ts");
    const g = "[round-trip:infra]";
    const hostMask = r.maskedStrings.find((x) => x.real === "billing.internal.acme.com")!.mask;
    const reply = `fetch("https://${hostMask}/health");`;
    const restored = masker.rehydrate(reply, r.session);
    check(`${g} internal host restored in reply`, has(restored, "billing.internal.acme.com"));
    check(`${g} host mask gone`, !has(restored, hostMask));
  }

  // ---- (c) round-trip with a MASKED MEMBER ----
  {
    const masker = new CodeMasker(resolveConfig({ maskMembers: true }));
    const r = masker.mask(MEMBERS_TS, "members.ts");
    const g = "[round-trip:member]";
    const scoreMask = r.maskedIdentifiers.find((x) => x.real === "score" && x.kind === "member")!.mask;
    // LLM reply references the masked member + invents a new method name.
    const reply = `s.${scoreMask}(); s.computeFreshMetric();`;
    const restored = masker.rehydrate(reply, r.session);
    check(`${g} member 'score' restored`, has(restored, "s.score()"));
    check(`${g} member mask gone`, !has(restored, scoreMask));
    check(`${g} LLM-invented method passed through`, has(restored, "computeFreshMetric"));
  }

  // ====================================================================
  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main();
