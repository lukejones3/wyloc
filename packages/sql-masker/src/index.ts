/**
 * @wyloc/sql-masker — AST-based, semantic-preserving SQL identifier masking.
 *
 * Mask proprietary tables/schemas/columns out of a SQL query before it is sent
 * to an LLM, while preserving query-local structure (CTEs, aliases) so the LLM
 * still gives good optimization advice — then rehydrate its response in-session.
 */
export { SqlMasker, type MaskResult } from "./engine.js";
export { rehydrate } from "./rehydrate.js";
export {
  scrubLiterals,
  type LiteralMapping,
  type LiteralScrubResult,
} from "./literals.js";
export { SessionMap } from "./session.js";
export { SqlglotWorker, type SqlglotWorkerOptions } from "./parser/sqlglot.js";
export type { SqlParser, Renames } from "./parser/types.js";
export {
  resolveConfig,
  type MaskerConfig,
  type MaskerConfigInput,
} from "./config.js";
export {
  tokenize,
  conceptTokens,
  echoesConcept,
  maskTableName,
  maskSchemaName,
  maskColumnName,
  maskAliasName,
} from "./mask.js";
export type {
  Dialect,
  PhysicalTable,
  Classification,
  IdentifierKind,
  MaskEntry,
} from "./types.js";
