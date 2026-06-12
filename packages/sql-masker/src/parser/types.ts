import type { Classification } from "../types.js";

/** Rename directives applied by the parser at the AST level. Keyed by real name. */
export interface Renames {
  /** physical table bare-name -> mask */
  tables: Record<string, string>;
  /** schema/namespace name -> mask */
  schemas: Record<string, string>;
  /** proprietary column bare-name -> mask */
  columns: Record<string, string>;
  /** query-local identifier (alias) name -> mask, renamed at every occurrence */
  identifiers: Record<string, string>;
  /** string-literal value -> scrubbed value, replaced by exact match */
  literals: Record<string, string>;
}

/**
 * The parser seam. Everything the engine needs from a SQL parser is these two
 * operations. The default implementation is a sqlglot Python worker
 * (SqlglotWorker); a future pure-JS/WASM parser could implement this same
 * interface for browser/edge without touching the masking engine.
 */
export interface SqlParser {
  /** Parse + scope-resolve a query into its identifier inventory. */
  classify(sql: string, dialect: string): Promise<Classification>;
  /** Return the distinct string-literal values in the query. */
  extractLiterals(sql: string, dialect: string): Promise<string[]>;
  /** Apply renames at the AST level and regenerate valid SQL in `dialect`. */
  rewrite(
    sql: string,
    dialect: string,
    renames: Renames,
    stripComments: boolean,
  ): Promise<string>;
  /** Release any held resources (e.g. the worker subprocess). */
  close(): void;
}
