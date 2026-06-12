# SQL masking experiment — results

_Shared prompt:_

> Optimize this Postgres query for performance. It runs on a large base table filtered to a small selective subset, then aggregates by a grouping column. Identify the most likely bottleneck, recommend specific indexes, and rewrite the query if it would help.


_Providers run: anthropic_


# Provider: anthropic



---

## anthropic · RAW  (model: claude-opus-4-8)

# Analysis

## The Core Problem: `feed` CTE is computed 3+ times

The biggest issue isn't indexing — it's the **query structure**. The `feed` CTE is referenced in `agg`, `exp_days`, and the correlated subquery in the SELECT. In Postgres, CTEs are not always materialized (since PG12 they can be inlined), but here:

1. `exp_days` re-scans `feed` but filters `status = 'expired'` — **yet `feed` itself filters `jp.status = 'raw'`**. This means **`exp_days` always returns zero rows** (`status` can't be both `'raw'` and `'expired'`). That's a latent bug producing a dead branch and wasted planning.

2. The correlated subquery `topVerticals` re-evaluates `feed` per output row. But `feed` already filtered `jp.domain = 'finance'`, so `f2.domain` is always `'finance'` — **`topVerticals` always returns `['finance']`**. Another dead/constant branch.

So two of three `feed` consumers are logically degenerate given the `WHERE` clauses inside `feed`. Confirm intent before optimizing.

## Likely Bottleneck

Given a "large base table → small selective subset," the bottleneck is the **scan of `job_postings`** before aggregation. The dominant selective predicates are:

```sql
jp.data_tier = 1 AND jp.status = 'raw' AND jp.domain = 'finance'
```

The location `OR` blob and the `NOT EXISTS` company-name filter are **non-sargable** (function calls, `OR` across columns, `LIKE '%...%'`) and should run *after* the index narrows rows, not drive the scan.

---

# Recommendations

## 1. Partial composite index on the selective equality predicates

```sql
CREATE INDEX idx_jp_finance_raw_feed
ON job_postings (company_id)
INCLUDE (job_id, domain, loc_country, loc_state, ingestion_source,
         workplace_type, salary_min_annual, salary_max_annual,
         status, posted_date, date_found, last_seen_at)
WHERE data_tier = 1 AND status = 'raw' AND domain = 'finance';
```

A **partial index** matching the constant predicates is ideal here because `data_tier=1`, `status='raw'`, `domain='finance'` are fixed in this query path. Leading with `company_id` supports the `GROUP BY`. The `INCLUDE` columns make it a **covering index**, avoiding heap fetches for the location/salary logic.

If these constants vary across other callers, drop the `WHERE` and make them index key columns instead:

```sql
CREATE INDEX idx_jp_feed
ON job_postings (data_tier, status, domain, company_id)
INCLUDE (job_id, loc_country, loc_state, ingestion_source,
         workplace_type, salary_min_annual, salary_max_annual,
         posted_date, date_found, last_seen_at);
```

## 2. Index the join

```sql
-- if not already PK/unique:
CREATE INDEX idx_mgi_job_id
ON analytics_analytics.mart_ghost_job_index (job_id)
INCLUDE (ghost_probability);

-- ensure companies join is indexed (PK normally covers this):
-- companies(company_id) PK assumed.
```

## 3. Fix the `NOT EXISTS` federal filter

`LOWER(c.company_name) LIKE '%' || match || '%'` against an unnested array is fine functionally, but it forces per-row work. Two improvements:

- Precompute `LOWER(c.company_name)` once.
- Consider a materialized exclusion set or a `pg_trgm` GIN index on `companies.company_name` if this list grows. For ~28 fixed terms, the bigger win is just running it on the already-narrowed row set.

```sql
CREATE INDEX idx_companies_name_trgm
ON companies USING gin (LOWER(company_name) gin_trgm_ops); -- requires pg_trgm
```

---

# Rewritten Query

Removing the degenerate branches and avoiding correlated re-scans. Assuming the `expired`/`topVerticals` logic was a real intent over a *broader* feed (not the `status='raw'`/`domain='finance'`-restricted one), I split the base scan so each consumer sees the correct rows. **If they truly should use the restricted feed, they are constants and should be hardcoded.**

```sql
WITH base AS MATERIALIZED (   -- scan job_postings ONCE; force materialization
  SELECT
    jp.company_id, jp.job_id, c.company_name, jp.domain, jp.status,
    (jp.salary_min_annual IS NOT NULL AND jp.salary_max_annual IS NOT NULL) AS disclosed,
    CASE
      WHEN mgi.ghost_probability::double precision > 1.0
        THEN mgi.ghost_probability::double precision / 100.0
      WHEN mgi.ghost_probability IS NOT NULL
        THEN mgi.ghost_probability::double precision
      ELSE NULL
    END AS gp,
    jp.posted_date, jp.date_found, jp.last_seen_at
  FROM job_postings jp
  JOIN companies c ON c.company_id = jp.company_id
  LEFT JOIN analytics_analytics.mart_ghost_job_index mgi ON mgi.job_id = jp.job_id
  WHERE jp.data_tier = 1
    AND jp.domain = 'finance'
    AND (jp.loc_country IS NULL OR jp.loc_country <> 'foreign')
    AND ( /* location OR-blob unchanged */ TRUE )   -- keep your existing OR logic here
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY[ /* federal list */ ]::text[]) AS federal_firm(match)
      WHERE LOWER(c.company_name) LIKE '%'


---

## anthropic · OPAQUE  (model: claude-opus-4-8)

# Performance Analysis

## The Primary Bottleneck: `cte_1` is materialized and scanned 3+ times

In Postgres, CTEs were an **optimization fence** before v12, and even in v12+ a CTE referenced **multiple times is automatically materialized** (computed once, stored, re-read). Your `cte_1` is referenced:

1. In `cte_2` (aggregation)
2. In `cte_3` (filtered aggregation)
3. In the correlated subquery for `out_7` — **once per output row** (this is the killer)

The correlated subquery `WHERE x2.col_1 = y1.col_1` forces a re-scan of the materialized `cte_1` for each of the up to 100 final rows. If `cte_1` materializes to many rows, that's 100 sequential scans over a materialized result with no index on it.

The **base-table filter** is also expensive but secondary: the `NOT EXISTS ... unnest ... LIKE '%...%'` runs a substring scan against ~27 patterns per row, and the giant `OR` block defeats simple index usage.

---

## Recommended Indexes

Drive the selective base filter on `table_a`. Your hard equality predicates are the index targets:

```sql
-- col_12=1, col_7='raw', col_3='finance' are equalities → leading columns
CREATE INDEX idx_table_a_filter
  ON table_a (col_12, col_3, col_7)
  INCLUDE (col_1, col_11, col_13, col_14, col_15, col_16,
           col_4, col_5, col_8, col_9, col_10);
```

Or, since the filter is fixed, a **partial index** is far smaller and more selective:

```sql
CREATE INDEX idx_table_a_finance_raw
  ON table_a (col_1)
  INCLUDE (col_11, col_13, col_14, col_15, col_16,
           col_4, col_5, col_8, col_9, col_10)
  WHERE col_12 = 1 AND col_7 = 'raw' AND col_3 = 'finance';
```

Join supports:

```sql
CREATE INDEX idx_table_b_col1 ON table_b (col_1) INCLUDE (col_2);
CREATE INDEX idx_table_c_col11 ON schema_a.table_c (col_11) INCLUDE (col_6);
```

For the `out_7` re-scans (if you keep the correlated form), having `cte_1`'s grouping work on `(col_1, col_3)` matters — but the real fix is structural (below).

---

## Rewrite: materialize once, eliminate the correlated re-scan

Compute the filtered set into a real temp table (or `MATERIALIZED` CTE you control), then do **all** aggregations as set-based passes. The `out_7` top-3 becomes a windowed aggregation instead of a per-row subquery.

```sql
-- Step 1: materialize the expensive filter exactly once
CREATE TEMP TABLE filtered ON COMMIT DROP AS
SELECT
  t1.col_1, t2.col_2, t1.col_3,
  (t1.col_4 IS NOT NULL AND t1.col_5 IS NOT NULL) AS d1,
  CASE
    WHEN t3.col_6::double precision > 1.0 THEN t3.col_6::double precision / 100.0
    WHEN t3.col_6 IS NOT NULL              THEN t3.col_6::double precision
    ELSE NULL
  END AS d2,
  t1.col_7, t1.col_8, t1.col_9, t1.col_10
FROM table_a t1
JOIN table_b t2 ON t2.col_1 = t1.col_1
LEFT JOIN schema_a.table_c t3 ON t3.col_11 = t1.col_11
WHERE t1.col_12 = 1
  AND t1.col_7 = 'raw'
  AND t1.col_3 = 'finance'
  AND (t1.col_13 IS NULL OR t1.col_13 <> 'foreign')
  AND <... the big OR block + NOT EXISTS unchanged ...>;

CREATE INDEX ON filtered (col_1);

-- Step 2: top-3 col_3 per group via window, no correlated subquery
WITH top3 AS (
  SELECT col_1, col_3, cnt,
         row_number() OVER (PARTITION BY col_1 ORDER BY cnt DESC) AS rn
  FROM (
    SELECT col_1, col_3, COUNT(*)::int AS cnt
    FROM filtered
    WHERE col_3 IS NOT NULL AND BTRIM(col_3::text) <> ''
    GROUP BY col_1, col_3
  ) s
),
top3_agg AS (
  SELECT col_1, ARRAY_AGG(col_3 ORDER BY cnt DESC) AS arr
  FROM top3 WHERE rn <= 3 GROUP BY col_1
),
agg AS (
  SELECT col_1,
         MAX(col_2) AS col_2,
         COUNT(*)::int AS d3,
         SUM(CASE WHEN d1 THEN 1 ELSE 0 END)::double precision
           / NULLIF(COUNT(*)::double precision, 0) AS d4,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY d2) AS d5
  FROM filtered GROUP BY col_1 HAVING COUNT(*) >= 20
),
dur AS (
  SELECT col_1,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (col_10 - COALESCE(col_8::timestamp, col_9::timestamp)))/86400.0
         ) AS d6
  FROM filtered
  WHERE col_7 = 'expired' AND col_10 IS NOT NULL
    AND (col_8 IS NOT NULL OR col_9 IS NOT NULL)
    AND COAL


---

## anthropic · SEMANTIC  (model: claude-opus-4-8)

# Analysis

## The Core Bottleneck

The single biggest problem isn't the indexes — it's that **`feed` is a CTE that gets materialized once but referenced three times**, and one of those references is inside a **correlated subquery in the final SELECT** (`feed f2 WHERE f2.company_id = a.company_id`).

In Postgres, a CTE referenced multiple times is materialized by default (pre-PG12 always; PG12+ when referenced more than once). That means:

1. `feed` is computed once (good), but it includes the **expensive WHERE clause** — the `NOT EXISTS` over an `unnest`'d array with `LIKE '%...%'`, the giant state `IN` lists, the join to `mart_risk_index`.
2. The correlated subquery for `"topVerticals"` re-scans the materialized `feed` **once per output company**. With `LIMIT 100` after sorting, that's up to 100 scans of the full materialized set.

Also notice: **`feed` itself already filters `jp.domain = 'finance'`**. So inside `topVerticals`, `f2.domain` is *always* `'finance'` — the entire `topVerticals` subquery is dead logic that can only ever return `['finance']`. That's a semantic bug worth confirming with the author, but it also means the most expensive part of the final SELECT is pointless.

## Secondary bottlenecks

- The `NOT EXISTS (... unnest(ARRAY[...]) ... LIKE '%match%')` runs a substring match against ~26 patterns for every candidate row. This can't use an index and is CPU-heavy. It belongs on the **company dimension**, not per-posting.
- The `LEFT JOIN mart_risk_index` is keyed on `job_id` and only used for `gp` / `median_ghost`. Fine as a join, but make sure it has a usable index.
- The big `UPPER(loc_state) IN (...)` / `loc_country IN (...)` predicate is a row-level CPU filter, not indexable as written.

---

# Recommended Indexes

The driving selective predicate is `data_tier = 1 AND status = 'raw' AND domain = 'finance'`. Build a partial composite index that captures the cheap, sargable equality filters and carries the columns needed downstream:

```sql
-- Primary access path for the `feed` scan
CREATE INDEX ix_fact_postings_feed
  ON fact_postings (company_id)
  INCLUDE (job_id, loc_country, loc_state, ingestion_source, workplace_type,
           salary_min_annual, salary_max_annual, status, posted_date,
           date_found, last_seen_at)
  WHERE data_tier = 1 AND domain = 'finance';
```

A partial index on `(data_tier=1, domain='finance')` is ideal because those are constant equality filters — it shrinks the index to exactly the working set. I left `status` out of the predicate because `feed` is reused for both `'raw'` and `'expired'` rows (the `exp_days` CTE filters `status='expired'` *after* the fact). If in practice you only ever need `status IN ('raw','expired')`, add that too.

For the join:

```sql
CREATE INDEX ix_mart_risk_index_job ON analytics_analytics.mart_risk_index (job_id)
  INCLUDE (risk_score);

-- companies join key (likely already the PK)
CREATE INDEX ix_companies_pk ON companies (company_id) INCLUDE (company_name);
```

For the federal-firm exclusion, precompute it on the dimension so it's evaluated once per company, not per posting:

```sql
-- a generated/maintained flag is far better than per-row LIKE
ALTER TABLE companies ADD COLUMN is_excluded_firm boolean;
-- populate via the LIKE logic once; refresh on company name change
CREATE INDEX ix_companies_not_excluded ON companies (company_id)
  WHERE is_excluded_firm IS NOT TRUE;
```

---

# Rewritten Query

Key changes:
1. **Force `feed` to materialize once** (`MATERIALIZED`) so the heavy filter runs a single time.
2. **Eliminate the correlated `topVerticals` subquery** — since `feed` is already `domain='finance'`, the result is constant. (Confirm intent; if the author meant to compute verticals from an *unfiltered* feed, that's a different fix — see note.)
3. **Move the federal-firm exclusion to the company dimension** (precomputed flag).
4. Compute the state-list / location predicate once; consider a static lookup table or domain.

```sql
WITH feed AS MATERIALIZED (
  SELECT
    jp.company_id,
    c.company_name,
    jp.domain,
    (jp.salary_min_annual IS NOT NULL AND jp.salary_max_annual IS NOT NULL) AS disclosed,
    CASE
      WHEN mgi.risk_score::double precision > 1.0
        THEN mgi.risk_score::double precision / 100.0
      WHEN mgi.risk_score IS NOT NULL
        THEN mgi.risk_score::double precision
      ELSE NULL
    END AS gp,
    jp.status,
    jp.posted_date,
    jp.date_found,
    jp.last_seen_at
  FROM fact_postings jp
  JOIN companies c
    ON c.company_id = jp.company_id
   AND c.is_excluded_firm IS NOT TRUE          -- exclusion moved to the dimension
  LEFT JOIN analytics_analytics.mart_risk_index mgi
    ON mgi.job_id = jp.job_id
  WHERE jp.data_tier = 1
    AND jp.status IN ('raw', 'expired')         -- both consumers need these; filtered per-CTE below
    AND jp.domain = 'finance'
    AND (jp.loc_country IS NULL OR jp.loc_country <> 'foreign')
    AND (
      (jp.loc_country IN ('US','United States