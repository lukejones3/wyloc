/**
 * Test runner for @wyloc/sql-masker. No test framework — run with: npm test
 * (uses tsx). Spawns ONE sqlglot worker and reuses it across all cases.
 *
 * Phase 2 verifies masking; Phase 3 verifies rehydration + round-trip.
 */
import { SqlMasker, SqlglotWorker, resolveConfig } from "../src/index.js";
import type { MaskResult } from "../src/index.js";
import {
  LANDER_RAW,
  NESTED_SUBQUERY,
  SCHEMA_QUALIFIED,
  CONCEPT_ECHO,
} from "./fixtures/queries.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const has = (hay: string, needle: string) => hay.includes(needle);
const wordPresent = (hay: string, w: string) =>
  new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`).test(hay);

async function main(): Promise<void> {
  const worker = new SqlglotWorker(); // single warm worker for the whole suite
  const cfg = resolveConfig();
  const masker = new SqlMasker(cfg, worker);

  // ====================================================================
  // PHASE 2 — MASKING
  // ====================================================================
  console.log("\n══ Phase 2: masking ══════════════════════════════════════");

  // ---- Primary fixture: the real Lander query (multi-CTE) ----
  {
    const r: MaskResult = await masker.mask(LANDER_RAW);
    const m = r.masked;
    const grp = "[lander]";

    // (a) physical tables/schema/column masked
    check(`${grp} job_postings classified physical`, r.maskedTables.includes("job_postings"));
    check(`${grp} companies classified physical`, r.maskedTables.includes("companies"));
    check(`${grp} mart_ghost_job_index classified physical`, r.maskedTables.includes("mart_ghost_job_index"));
    check(`${grp} analytics_analytics schema masked`, r.maskedSchemas.includes("analytics_analytics"));
    check(`${grp} ghost_probability column masked`, r.maskedColumns.includes("ghost_probability"));

    // (a) the real proprietary names are GONE from the output
    for (const real of ["job_postings", "mart_ghost_job_index", "analytics_analytics", "ghost_probability"]) {
      check(`${grp} '${real}' absent from masked SQL`, !has(m, real));
    }
    // concept fully scrubbed — no "ghost" anywhere (incl. comments + echo aliases)
    check(`${grp} no "ghost" concept leak (incl. comments/aliases)`, !/ghost/i.test(m),
      /ghost/i.test(m) ? "found 'ghost' substring" : "");

    // (b) CTE aliases preserved, untouched
    for (const cte of ["feed", "agg", "exp_days"]) {
      check(`${grp} CTE '${cte}' preserved`, wordPresent(m, cte) && r.preservedCtes.includes(cte));
    }
    // table aliases preserved
    check(`${grp} table alias 'jp' preserved`, wordPresent(m, "jp"));

    // concept-echo aliases caught (snake + quoted camel)
    check(`${grp} alias 'median_ghost' masked`, r.maskedAliases.includes("median_ghost"));
    check(`${grp} alias 'medianGhost' masked`, r.maskedAliases.includes("medianGhost"));

    // generic columns NOT over-masked
    check(`${grp} generic 'company_id' preserved`, has(m, "company_id"));
    check(`${grp} generic 'status' preserved`, has(m, "status"));

    // (c) consistency: masks present + masked SQL re-parses with no real physical names
    check(`${grp} table mask present`, has(m, r.session.maskFor("job_postings") ?? "\0"));
    const reclass = await worker.classify(m, "postgres");
    const reNames = new Set(reclass.physicalTables.map((t) => t.name));
    check(`${grp} masked SQL re-parses`, reclass.physicalTables.length > 0);
    check(`${grp} no original physical name survives re-parse`,
      !reNames.has("job_postings") && !reNames.has("mart_ghost_job_index"));

    // determinism: same input → identical output + session (default empty salt)
    const r2 = await masker.mask(LANDER_RAW);
    check(`${grp} deterministic masked output`, r2.masked === m);
    check(`${grp} deterministic session size`, r2.session.size === r.session.size);
  }

  // ---- Nested derived-table subquery + schema-qualified source ----
  {
    const r = await masker.mask(NESTED_SUBQUERY);
    const m = r.masked;
    const grp = "[nested]";
    // dim_users is all-generic vocab (dim_ + users), so its mask is
    // dim_users_<hash>: nothing proprietary to strip, just a tracking hash.
    // The real identifier must no longer stand alone (identifier-boundary check),
    // and the masked token must be present.
    check(`${grp} dim_users masked`,
      r.maskedTables.includes("dim_users")
      && !wordPresent(m, "dim_users")
      && has(m, r.session.maskFor("dim_users") ?? "\0"));
    check(`${grp} fct_user_events masked`, r.maskedTables.includes("fct_user_events") && !has(m, "fct_user_events"));
    check(`${grp} analytics schema masked`, r.maskedSchemas.includes("analytics") && !wordPresent(m, "analytics"));
    check(`${grp} no CTEs to preserve`, r.preservedCtes.length === 0);
    check(`${grp} derived alias 't' preserved`, wordPresent(m, "t"));
    check(`${grp} generic 'user_id' NOT masked`, has(m, "user_id") && r.maskedColumns.length === 0);
    const re = await worker.classify(m, "postgres");
    check(`${grp} masked SQL re-parses`, re.physicalTables.length === 2);
  }

  // ---- Schema-qualified names + prefix/entity shape preservation ----
  {
    const r = await masker.mask(SCHEMA_QUALIFIED);
    const m = r.masked;
    const grp = "[schema-qual]";
    const dimMask = r.session.maskFor("dim_store_locations") ?? "";
    const factMask = r.session.maskFor("fact_orders") ?? "";
    check(`${grp} dim_store_locations → dim_locations_<hash> shape`,
      /^dim_locations_[a-z0-9]+$/.test(dimMask), `got "${dimMask}"`);
    check(`${grp} fact_orders → fact_orders_<hash> shape`,
      /^fact_orders_[a-z0-9]+$/.test(factMask), `got "${factMask}"`);
    check(`${grp} proprietary token 'store' stripped`, !/store/i.test(m));
    check(`${grp} schemas masked`, r.maskedSchemas.includes("sales") && r.maskedSchemas.includes("warehouse"));
    check(`${grp} generic cols preserved`, has(m, "order_id") && has(m, "total_amount") && has(m, "region"));
    const re = await worker.classify(m, "postgres");
    check(`${grp} masked SQL re-parses`, re.physicalTables.length === 2);
  }

  // ---- Concept-echo alias (the validation finding) ----
  {
    const r = await masker.mask(CONCEPT_ECHO);
    const m = r.masked;
    const grp = "[concept-echo]";
    check(`${grp} job_postings masked`, !has(m, "job_postings"));
    check(`${grp} mart_ghost_job_index masked`, !has(m, "mart_ghost_job_index"));
    check(`${grp} ghost_probability masked`, r.maskedColumns.includes("ghost_probability"));
    check(`${grp} 'ghost' concept token derived`, r.conceptTokens.includes("ghost"));
    check(`${grp} alias 'median_ghost' masked`, r.maskedAliases.includes("median_ghost"));
    check(`${grp} alias 'gp' NOT masked (no echo)`, !r.maskedAliases.includes("gp") && wordPresent(m, "gp"));
    check(`${grp} CTE 'feed' preserved`, r.preservedCtes.includes("feed") && wordPresent(m, "feed"));
    check(`${grp} no "ghost" anywhere`, !/ghost/i.test(m));
    // consistency: median_ghost occurs twice in source (def + ORDER BY) — both gone
    check(`${grp} median_ghost replaced at all references`, !has(m, "median_ghost"));
  }

  // ====================================================================
  // PHASE 3 — REHYDRATION + ROUND-TRIP
  // ====================================================================
  console.log("══ Phase 3: rehydration + round-trip ═════════════════════");

  // ---- Identifier-level round-trip on the Lander query ----
  {
    const r = await masker.mask(LANDER_RAW);
    const back = masker.rehydrate(r.masked, r.session);
    const grp = "[roundtrip]";
    for (const real of ["job_postings", "mart_ghost_job_index", "analytics_analytics", "ghost_probability", "median_ghost"]) {
      check(`${grp} '${real}' restored`, has(back, real));
    }
    // every mask token is gone after rehydration
    const leftover = r.session.entries().filter((e) => has(back, e.mask));
    check(`${grp} no mask tokens remain`, leftover.length === 0,
      leftover.length ? `left: ${leftover.map((e) => e.mask).join(", ")}` : "");
    // CTE names (never masked) still present and intact
    check(`${grp} CTE 'feed' still present`, wordPresent(back, "feed"));
  }

  // ---- Tolerance: LLM "rewrite" with invented identifiers ----
  {
    const r = await masker.mask(CONCEPT_ECHO);
    const tmask = r.session.maskFor("job_postings") ?? "";
    const grp = "[llm-rewrite]";
    // Simulate the model's reply: uses our masks AND invents new names.
    const llm = [
      "To optimize, add a covering index:",
      "```sql",
      `CREATE INDEX ix_${tmask}_company ON ${tmask} (company_id);`,
      `ALTER TABLE ${tmask} ADD COLUMN risk_bucket int;`,
      "```",
      `This indexes ${tmask} on company_id; the new risk_bucket column helps.`,
    ].join("\n");
    const back = masker.rehydrate(llm, r.session);

    check(`${grp} standalone mask → real (job_postings)`, has(back, "ON job_postings ("));
    check(`${grp} prose 'indexes job_postings' restored`, has(back, "indexes job_postings on"));
    check(`${grp} invented index name passes through (embedded mask untouched)`,
      has(back, `ix_${tmask}_company`));
    check(`${grp} invented column 'risk_bucket' passes through`, has(back, "risk_bucket"));
    check(`${grp} unmasked 'company_id' untouched`, has(back, "company_id"));
  }

  // ---- Rehydration leaves fully-unknown text unchanged ----
  {
    const r = await masker.mask(CONCEPT_ECHO);
    const unknown = "SELECT foo, bar FROM unrelated_table WHERE x = 1;";
    check("[passthrough] unknown text unchanged", masker.rehydrate(unknown, r.session) === unknown);
  }

  // ====================================================================
  // PHASE A — LITERAL / VALUE SCRUBBING (via @wyloc/detector)
  // ====================================================================
  console.log("══ Phase A: literal/value scrubbing ══════════════════════");

  // ---- org blocklist substrings (e.g. the federal-staffing list) ----
  {
    const grp = "[blocklist]";
    const m2 = new SqlMasker(
      resolveConfig({ sensitiveValueSubstrings: ["booz allen", "leidos", "northrop grumman"] }),
      worker,
    );
    const r = await m2.mask(LANDER_RAW);
    const m = r.masked;
    check(`${grp} 'booz allen' redacted`, !/booz allen/i.test(m));
    check(`${grp} 'leidos' redacted`, !/leidos/i.test(m));
    check(`${grp} 'northrop grumman' redacted`, !/northrop grumman/i.test(m));
    check(`${grp} non-listed 'saic' literal preserved`, /'saic'/.test(m));
    check(`${grp} scrubbedLiterals records it`, r.scrubbedLiterals.includes("booz allen"));
    check(`${grp} redaction token emitted`, /wyloc_blocked_/.test(m));
    // identifier masking still works alongside literal scrubbing
    check(`${grp} identifiers still masked`, !has(m, "job_postings") && !/ghost/i.test(m));
    const back = m2.rehydrate(m, r.session);
    check(`${grp} rehydrate restores 'booz allen'`, /booz allen/i.test(back) && !/wyloc_blocked_/.test(back));
  }

  // ---- detector-found secret embedded in a literal ----
  {
    const grp = "[secret-literal]";
    const sql =
      "SELECT id FROM logs WHERE dsn = 'postgres://admin:s3cr3t@prod-db.acme.io:5432/billing';";
    const r = await masker.mask(sql);
    const m = r.masked;
    check(`${grp} real secret host/pw absent`, !has(m, "s3cr3t") && !has(m, "prod-db.acme.io"));
    check(`${grp} a literal was scrubbed`, r.scrubbedLiterals.length >= 1);
    const back = masker.rehydrate(m, r.session);
    check(`${grp} rehydrate restores the secret`, has(back, "prod-db.acme.io"));
  }

  // ---- PII pattern (email) ----
  {
    const grp = "[pii]";
    const m2 = new SqlMasker(
      resolveConfig({ sensitiveValuePatterns: [/[\w.+-]+@[\w.-]+\.\w+/] }),
      worker,
    );
    const r = await m2.mask("SELECT id FROM users WHERE email = 'jane.doe@acme.com';");
    const m = r.masked;
    check(`${grp} email redacted`, !/jane\.doe@acme\.com/.test(m) && /wyloc_redacted_/.test(m));
    check(`${grp} scrubbedLiterals records email`, r.scrubbedLiterals.includes("jane.doe@acme.com"));
    const back = m2.rehydrate(m, r.session);
    check(`${grp} rehydrate restores email`, has(back, "jane.doe@acme.com"));
  }

  // ---- default: benign literals are left alone ----
  {
    const r = await masker.mask(NESTED_SUBQUERY);
    check("[default-scrub] benign literals untouched", r.scrubbedLiterals.length === 0);
  }

  // ---- toggle: scrubLiterals=false disables the pass ----
  {
    const m2 = new SqlMasker(
      resolveConfig({ scrubLiterals: false, sensitiveValueSubstrings: ["booz allen"] }),
      worker,
    );
    const r = await m2.mask(LANDER_RAW);
    check("[scrub-off] disabled → blocklist literal remains",
      /booz allen/i.test(r.masked) && r.scrubbedLiterals.length === 0);
  }

  worker.close();

  // ---- report ----
  console.log(`\n${"─".repeat(58)}`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(f);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("test runner crashed:", e);
  process.exitCode = 1;
});
