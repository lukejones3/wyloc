# SQL masking → LLM optimization-advice experiment

Tests whether **SEMANTIC** masking (hide only proprietary identifiers, keep
functional roles visible) preserves RAW-level Postgres optimization advice while
**OPAQUE** masking (meaningless tokens) degrades it.

## Source query
Real query: `lander/lib/db/insights.ts` → `getCompanyInsightRows()` (the only
`WITH feed AS …` query in the codebase). Expanded to standalone SQL for the
`finance` vertical, `sort='honest'`, with `${scope}` and
`sqlExcludeFederalStaffingCompanies('c')` inlined.

### ⚠️ Deviations from the original brief
- The brief described CTEs `feed` + `by_vertical`. **No `by_vertical` CTE exists.**
  The real CTEs are `feed` → `agg` → `exp_days`, and the grouping column is
  **`company_id`** (with `HAVING COUNT(*) >= 20`), not a vertical. Kept faithful
  to the real query and left all three CTE aliases unchanged.
- The query carries identifiers the brief didn't list: the `companies` table and
  the `analytics_analytics` schema. `companies` is treated as generic (left as-is
  in SEMANTIC); only `mart_ghost_job_index`/`ghost_probability`/`job_postings`
  were treated as proprietary.

## The three versions (`queries/`)
All three are **structurally identical** — verified that reversing the SEMANTIC
token swaps reproduces `raw.sql` byte-for-byte, so identifier masking is the only
variable.

| | what changes |
|---|---|
| `raw.sql` | nothing — real identifiers |
| `opaque.sql` | every table/schema/column/alias/CTE → `table_a`, `col_1`, `cte_1`, `d1`, `out_1`… ; keywords, structure, and data literals intact |
| `semantic.sql` | only `job_postings`→`fact_postings`, `mart_ghost_job_index`→`mart_risk_index`, `ghost_probability`→`risk_score` |

## Findings baked in before any API call
1. **Data literals leak in all three versions.** The federal-staffing company
   blocklist (`booz allen`, `leidos`, `northrop grumman`, …) and the `'finance'`
   slice are string *values*, not identifiers, so an identifier-only masker —
   RAW, OPAQUE, *and* SEMANTIC — sends them verbatim. If that blocklist is IP,
   the taxonomy needs a literal-masking pass too.
2. **Query-local aliases can still echo the concept.** `gp` and `median_ghost`
   are derived from `ghost_probability`. The brief says leave query-local names
   alone, so SEMANTIC keeps them — but `median_ghost` still spells "ghost".
3. **Latent bug in the real query (not masking-related):** `feed` filters
   `jp.status = 'raw'`, then `exp_days` filters that same CTE for
   `status = 'expired'` → `exp_days` is always empty, so `medianDaysToClose` is
   always NULL. Worth a look in `insights.ts` independent of this experiment.

## Run it
```bash
cd experiments/sql-masking
ANTHROPIC_API_KEY=sk-ant-... python3 run_experiment.py
```
Stdlib only (no pip install). Writes:
- `responses/<v>.prompt.txt`  — exact prompt sent
- `responses/<v>.response.txt` / `.response.json` — model output
- `results.md` — all three side by side

Then I read `results.md` and write the comparison report: did OPAQUE and
SEMANTIC each find the same bottleneck + index recs as RAW, where each degraded,
and whether the model kept the masked token names verbatim in any rewrite.
