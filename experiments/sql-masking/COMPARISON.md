# Masking comparison — Anthropic (claude-opus-4-8)

Run: `--provider anthropic`, 2026-06-11. RAW / OPAQUE / SEMANTIC, same prompt.
Cross-model (OpenAI) side **not yet run** — no `OPENAI_API_KEY` available here.
So this is the single-provider half; the dual-model validation needs the OpenAI run.

## Did each version find the same bottleneck as RAW?

| Finding | RAW | OPAQUE | SEMANTIC |
|---|:---:|:---:|:---:|
| Primary bottleneck = CTE materialized + correlated subquery re-scans `feed`/`cte_1` per output row | ✅ | ✅ | ✅ |
| Secondary = base-table scan of the selective subset before aggregation | ✅ | ✅ | ✅ |
| Non-sargable `NOT EXISTS … unnest … LIKE '%…%'` + `OR` location blob | ✅ | ✅ | ✅ |
| **Semantic bug: `exp_days` filters `status='expired'` on a `status='raw'` feed → always empty** | ✅ explicit | ❌ missed | ⚠️ implicit |
| **Semantic bug: `topVerticals` is constant `['finance']` (feed already `domain='finance'`)** | ✅ explicit | ❌ missed | ✅ explicit |

**Bottleneck + index advice: no degradation in any version.** All three recommended the
*same* core indexes:
- Partial **covering** index on the grouping column (`company_id` / `col_1`) keyed by the
  constant equality predicates (`data_tier=1, status='raw', domain='finance'`), with the
  downstream columns in `INCLUDE`.
- Join index on the mart `(job_id) INCLUDE (<score col>)`.
- `companies(company_id)` (noted as likely PK).
- Push the federal-firm `LIKE` exclusion off the per-row path (RAW/OPAQUE: pg_trgm GIN or a
  materialized set; SEMANTIC: a precomputed `is_excluded_firm` boolean on `companies`).

## Where each degraded

- **OPAQUE degraded only on business-logic insight.** It missed *both* degenerate-branch bugs
  — even though the data literals `'raw'`, `'expired'`, `'finance'` were still present in the
  OPAQUE query (the taxonomy masks identifiers, not literals). Meaningless identifiers were
  enough to stop the model from connecting `col_7='raw'` to the downstream `col_7='expired'`.
  Structural and index advice stayed fully intact.
- **SEMANTIC ≈ RAW.** It caught the `topVerticals` constant bug explicitly and produced a
  *more* actionable dimension-side fix than RAW. Its one soft spot: it handled the
  `exp_days` status contradiction *implicitly* (quietly broadening the feed to
  `status IN ('raw','expired')`) instead of flagging it as a zero-row bug the way RAW did.

## Did the model keep the masked tokens verbatim in rewrites?

**Yes — no renaming, in either masked version.**
- OPAQUE rewrite used `table_a`, `table_b`, `schema_a.table_c`, `col_1…col_16` verbatim.
- SEMANTIC rewrite used `fact_postings`, `mart_risk_index`, `risk_score` verbatim.

So you would **not** need to force verbatim output. Caveat: the model *invents new*
identifiers for objects it adds (index names like `ix_fact_postings_feed`, and SEMANTIC
introduced a new `companies.is_excluded_firm` column). Those are additions, not renames of
your masked tokens — but a round-trip un-masker must tolerate unknown new identifiers.

## Verdict (Anthropic side)
The hypothesis holds on claude-opus-4-8: **SEMANTIC preserves RAW-level optimization quality;
OPAQUE degrades specifically on semantic/business-logic reasoning while keeping perf+index
advice intact.** Notably, OPAQUE's degradation persisted even though the proprietary string
literals (federal-staffing blocklist, `'finance'`) leaked through unmasked — confirming the
earlier finding that this identifier-only taxonomy both (a) under-protects (literals leak) and
(b) is unnecessary to that degree for perf advice, since SEMANTIC's lighter touch sufficed.

**Next:** run `--provider openai` (or `both`) to confirm the SEMANTIC≈RAW / OPAQUE-degrades
pattern reproduces on a second model. That cross-model agreement is the real validation for a
provider-agnostic masking product.
