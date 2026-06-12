import { fileURLToPath } from "node:url";
import type { DetectorConfig } from "@wyloc/detector";
import type { Dialect } from "./types.js";

/**
 * Masking policy. This is the seam that becomes the enterprise `wyloc.json`
 * central policy: every knob that decides *what* counts as proprietary and
 * *how* a mask is shaped lives here, so defaults can ship now and orgs can
 * override later without touching the engine.
 */
export interface MaskerConfig {
  dialect: Dialect;

  // --- which identifier classes to mask ---
  maskTables: boolean;
  maskSchemas: boolean;
  maskColumns: boolean;
  /** Mask query-local alias names that *contain* a masked concept (median_ghost). */
  maskConceptEchoAliases: boolean;

  // --- vocabulary that shapes masks / decides proprietary-ness ---
  /** Table-type prefixes preserved on the mask (fact_/dim_/mart_/stg_…). */
  tablePrefixes: readonly string[];
  /** Entity nouns preserved as a trailing shape word (…_locations, …_orders). */
  entityNouns: readonly string[];
  /** Column type/measure suffixes preserved on a masked column (…_id, …_score). */
  columnSuffixes: readonly string[];
  /** Column names that are never proprietary (id, created_at, status…). */
  genericColumns: readonly string[];
  /** Tokens that are never a "proprietary concept" even if they survive splitting. */
  stopTokens: readonly string[];

  // --- column proprietary-ness ---
  /** Explicit proprietary columns (exact name or regex). */
  proprietaryColumns: readonly (string | RegExp)[];
  /** Also auto-mask any column whose name contains a derived concept token. */
  autoMaskConceptColumns: boolean;

  // --- literal/value scrubbing (a separate AST pass, uses @wyloc/detector) ---
  /** Master toggle for the literal-scrubbing pass. */
  scrubLiterals: boolean;
  /** Run the detector over each string literal and mock any secrets it finds. */
  scrubSecretsInLiterals: boolean;
  /** Org blocklist: any literal CONTAINING one of these (case-insensitive) is redacted. */
  sensitiveValueSubstrings: readonly string[];
  /** PII/value regexes: any literal matching one is redacted (e.g. email, SSN). */
  sensitiveValuePatterns: readonly RegExp[];
  /** Config passed through to the detector's scan(). */
  detectorConfig: Partial<DetectorConfig>;

  // --- knobs ---
  minConceptTokenLength: number;
  hashLength: number;
  /** Per-session salt. "" = fully deterministic. Pass random for cross-session unlinkability. */
  sessionSalt: string;
  schemaMaskPrefix: string;
  fallbackTablePrefix: string;
  stripComments: boolean;

  // --- worker ---
  pythonPath: string;
  workerPath: string;
}

export type MaskerConfigInput = Partial<MaskerConfig>;

const DEFAULT_TABLE_PREFIXES = [
  "fact", "fct", "dim", "mart", "stg", "int", "raw", "ref", "ods", "bridge", "snap",
] as const;

const DEFAULT_ENTITY_NOUNS = [
  "postings", "listings", "locations", "orders", "users", "customers",
  "accounts", "products", "events", "sessions", "transactions", "items",
  "invoices", "payments", "shipments", "reviews", "messages", "candidates",
  "applications", "subscriptions", "companies", "stores", "sales",
] as const;

const DEFAULT_COLUMN_SUFFIXES = [
  "id", "at", "ts", "date", "time", "score", "rate", "probability", "amount",
  "count", "total", "pct", "ratio", "flag", "num", "min", "max", "avg", "sum",
  "key", "code", "status", "type",
] as const;

const DEFAULT_GENERIC_COLUMNS = [
  "id", "created_at", "updated_at", "deleted_at", "created", "updated",
  "status", "type", "name", "email", "phone", "address", "city", "state",
  "country", "zip", "url", "description", "title", "count", "total", "amount",
  "date", "time", "timestamp", "uuid", "slug",
] as const;

/** Generic structural / warehouse words that should never be treated as a concept. */
const DEFAULT_STOP_TOKENS = [
  "index", "table", "data", "temp", "tmp", "view", "test", "prod", "dev",
  "main", "base", "src", "val", "key", "info", "meta", "map", "list", "set",
  "log", "row", "col", "analytics", "warehouse", "reporting", "staging",
  "public", "dwh", "dbt", "report", "summary", "detail",
  // common singular domain nouns — too generic to be a "proprietary concept"
  "user", "account", "order", "item", "event", "product", "customer",
  "company", "job", "person", "group", "role", "team", "org", "unit", "sale",
] as const;

/** The worker script ships alongside this package at <pkg>/python/worker.py. */
function defaultWorkerPath(): string {
  // src/config.ts -> ../python ; dist/config.js -> ../python  (both one level under pkg root)
  return fileURLToPath(new URL("../python/worker.py", import.meta.url));
}

export function resolveConfig(input: MaskerConfigInput = {}): MaskerConfig {
  return {
    dialect: input.dialect ?? "postgres",
    maskTables: input.maskTables ?? true,
    maskSchemas: input.maskSchemas ?? true,
    maskColumns: input.maskColumns ?? true,
    maskConceptEchoAliases: input.maskConceptEchoAliases ?? true,
    tablePrefixes: input.tablePrefixes ?? DEFAULT_TABLE_PREFIXES,
    entityNouns: input.entityNouns ?? DEFAULT_ENTITY_NOUNS,
    columnSuffixes: input.columnSuffixes ?? DEFAULT_COLUMN_SUFFIXES,
    genericColumns: input.genericColumns ?? DEFAULT_GENERIC_COLUMNS,
    stopTokens: input.stopTokens ?? DEFAULT_STOP_TOKENS,
    proprietaryColumns: input.proprietaryColumns ?? [],
    autoMaskConceptColumns: input.autoMaskConceptColumns ?? true,
    scrubLiterals: input.scrubLiterals ?? true,
    scrubSecretsInLiterals: input.scrubSecretsInLiterals ?? true,
    sensitiveValueSubstrings: input.sensitiveValueSubstrings ?? [],
    sensitiveValuePatterns: input.sensitiveValuePatterns ?? [],
    detectorConfig: input.detectorConfig ?? {},
    minConceptTokenLength: input.minConceptTokenLength ?? 4,
    hashLength: input.hashLength ?? 6,
    sessionSalt: input.sessionSalt ?? "",
    schemaMaskPrefix: input.schemaMaskPrefix ?? "schema",
    fallbackTablePrefix: input.fallbackTablePrefix ?? "tbl",
    stripComments: input.stripComments ?? true,
    pythonPath: input.pythonPath ?? "python3",
    workerPath: input.workerPath ?? defaultWorkerPath(),
  };
}
