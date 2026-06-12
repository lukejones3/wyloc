/** Public shared types for @wyloc/sql-masker. */

/**
 * SQL dialect passed through to the parser. Postgres is the default (our test
 * data); Snowflake / BigQuery are the real market and are supported by the
 * underlying parser via this same field.
 */
export type Dialect =
  | "postgres"
  | "snowflake"
  | "bigquery"
  | "redshift"
  | "duckdb"
  | "mysql"
  | "tsql"
  | (string & {});

/** A physical (real) table reference, as resolved by the parser's scope analysis. */
export interface PhysicalTable {
  name: string;
  schema: string | null;
  catalog: string | null;
}

/** The identifier inventory the parser returns for a query. */
export interface Classification {
  /** Real base tables/views — these are proprietary and get masked. */
  physicalTables: PhysicalTable[];
  /** WITH/CTE names — query-local, preserved (unless they echo a masked concept). */
  cteNames: string[];
  /** Table aliases + projection/derived aliases (excludes CTE names). */
  aliases: string[];
  /** Distinct column identifier names referenced anywhere in the query. */
  columns: string[];
}

/** What an identifier was classified as, for the session map. */
export type IdentifierKind = "table" | "schema" | "column" | "alias" | "literal";

/** One real→mask mapping recorded in the session. */
export interface MaskEntry {
  kind: IdentifierKind;
  real: string;
  mask: string;
}
