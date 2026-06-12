-- RAW — real identifiers, unchanged.
-- Source: lander/lib/db/insights.ts getCompanyInsightRows()
--   vertical slice = 'finance'; sort = 'honest' (median_ghost ASC NULLS LAST, active_jobs DESC)
--   ${scope} and sqlExcludeFederalStaffingCompanies('c') expanded inline.
WITH feed AS (
  SELECT
    jp.company_id,
    c.company_name,
    jp.domain,
    (jp.salary_min_annual IS NOT NULL AND jp.salary_max_annual IS NOT NULL) AS disclosed,
    CASE
      WHEN mgi.ghost_probability::double precision > 1.0
        THEN mgi.ghost_probability::double precision / 100.0
      WHEN mgi.ghost_probability IS NOT NULL
        THEN mgi.ghost_probability::double precision
      ELSE NULL
    END AS gp,
    jp.status,
    jp.posted_date,
    jp.date_found,
    jp.last_seen_at
  FROM job_postings jp
  JOIN companies c ON c.company_id = jp.company_id
  LEFT JOIN analytics_analytics.mart_ghost_job_index mgi ON mgi.job_id = jp.job_id
  WHERE jp.data_tier = 1
    AND jp.status = 'raw'
    AND (jp.loc_country IS NULL OR jp.loc_country <> 'foreign')
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'cgsfederal','accenture federal','booz allen','mantech','saic','caci','prosidian',
        'guidehouse','gdit','leidos','northrop grumman','parsons federal','serco federal',
        'deloitte federal','parsons','invisible agency','cermaticom','jobs for humanity',
        'devoteam','canonical','nxp semiconductors','relx','bosch group','about you se',
        'sixt','scalablegmbh'
      ]::text[]) AS federal_firm(match)
      WHERE LOWER(c.company_name) LIKE '%' || federal_firm.match || '%'
    )
    AND (
      (
        jp.loc_country IN ('US', 'United States', 'USA')
        AND (
          jp.loc_state IS NULL
          OR UPPER(jp.loc_state) IN (
            'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
            'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
            'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP'
          )
        )
      )
      OR (
        jp.loc_country IS NULL
        AND UPPER(COALESCE(jp.loc_state, '')) IN (
          'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
          'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
          'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP'
        )
      )
      OR (
        jp.loc_country = 'unknown'
        AND LOWER(COALESCE(jp.ingestion_source, '')) IN ('greenhouse', 'lever', 'ashby')
      )
      OR (
        jp.loc_country = 'unknown'
        AND LOWER(COALESCE(jp.ingestion_source, '')) = 'workday'
        AND LOWER(COALESCE(jp.workplace_type, '')) = 'remote'
      )
    )
    AND jp.domain = 'finance'
),
agg AS (
  SELECT
    company_id,
    MAX(company_name) AS company_name,
    COUNT(*)::int AS active_jobs,
    SUM(CASE WHEN disclosed THEN 1 ELSE 0 END)::double precision
      / NULLIF(COUNT(*)::double precision, 0) AS salary_disclosure_rate,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY gp) AS median_ghost
  FROM feed
  GROUP BY company_id
  HAVING COUNT(*) >= 20
),
exp_days AS (
  SELECT
    f.company_id,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (f.last_seen_at - COALESCE(f.posted_date::timestamp, f.date_found::timestamp)))
        / 86400.0
    ) AS median_days
  FROM feed f
  WHERE f.status = 'expired'
    AND f.last_seen_at IS NOT NULL
    AND (f.posted_date IS NOT NULL OR f.date_found IS NOT NULL)
    AND COALESCE(f.posted_date::timestamp, f.date_found::timestamp) <= f.last_seen_at
  GROUP BY f.company_id
  HAVING COUNT(*) >= 5
)
SELECT
  a.company_id::text AS "companyId",
  a.company_name AS "companyName",
  a.active_jobs AS "activeJobs",
  COALESCE(a.salary_disclosure_rate, 0)::double precision AS "salaryDisclosureRate",
  a.median_ghost::double precision AS "medianGhost",
  e.median_days::double precision AS "medianDaysToClose",
  COALESCE(
    (
      SELECT ARRAY_AGG(s.domain ORDER BY s.cnt DESC)
      FROM (
        SELECT f2.domain, COUNT(*)::int AS cnt
        FROM feed f2
        WHERE f2.company_id = a.company_id
          AND f2.domain IS NOT NULL
          AND BTRIM(f2.domain::text) <> ''
        GROUP BY f2.domain
        ORDER BY cnt DESC
        LIMIT 3
      ) s
    ),
    ARRAY[]::text[]
  ) AS "topVerticals"
FROM agg a
LEFT JOIN exp_days e ON e.company_id = a.company_id
ORDER BY a.median_ghost ASC NULLS LAST, a.active_jobs DESC
LIMIT 100;
