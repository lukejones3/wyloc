import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Primary fixture: the real Lander query from the validation experiment. */
export const LANDER_RAW = readFileSync(
  fileURLToPath(
    new URL("../../../../experiments/sql-masking/queries/raw.sql", import.meta.url),
  ),
  "utf8",
);

/** Nested (derived-table) subquery + schema-qualified source. */
export const NESTED_SUBQUERY = `
SELECT u.user_id, t.cnt
FROM dim_users u
JOIN (
  SELECT user_id, COUNT(*) AS cnt
  FROM analytics.fct_user_events
  WHERE event_type = 'click'
  GROUP BY user_id
) t ON t.user_id = u.user_id
WHERE u.status = 'active';
`;

/** Two schema-qualified physical tables with prefix/entity shapes to preserve. */
export const SCHEMA_QUALIFIED = `
SELECT o.order_id, o.total_amount, s.region
FROM sales.dim_store_locations s
JOIN warehouse.fact_orders o ON o.location_id = s.location_id
WHERE s.region = 'EMEA';
`;

/**
 * The concept-echo case from our validation: masking ghost_probability, but a
 * downstream alias `median_ghost` re-leaks the "ghost" concept.
 */
export const CONCEPT_ECHO = `
WITH feed AS (
  SELECT p.company_id, m.ghost_probability AS gp
  FROM job_postings p
  JOIN analytics_analytics.mart_ghost_job_index m ON m.job_id = p.job_id
)
SELECT
  company_id,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY gp) AS median_ghost
FROM feed
GROUP BY company_id
ORDER BY median_ghost DESC;
`;
