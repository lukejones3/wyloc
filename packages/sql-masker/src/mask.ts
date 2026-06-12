import type { MaskerConfig } from "./config.js";
import { shortHash } from "./hash.js";

/** Split an identifier into lowercase tokens across snake_case and camelCase. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_\s]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Derive the set of "proprietary concept" tokens from the real identifiers we
 * are masking. A token survives if it is long enough and is not generic
 * vocabulary (prefix / suffix / entity noun / generic column / stop word).
 *
 * e.g. mart_ghost_job_index -> {ghost}  ("mart","index" generic; "job" too short)
 *      ghost_probability     -> {ghost}  ("probability" is a generic suffix)
 * These tokens are what makes a downstream alias like `median_ghost` leak.
 */
export function conceptTokens(realNames: Iterable<string>, cfg: MaskerConfig): Set<string> {
  const generic = new Set<string>([
    ...cfg.tablePrefixes,
    ...cfg.entityNouns,
    ...cfg.columnSuffixes,
    ...cfg.genericColumns.flatMap(tokenize),
    ...cfg.stopTokens,
  ]);
  const out = new Set<string>();
  for (const name of realNames) {
    for (const tok of tokenize(name)) {
      if (tok.length >= cfg.minConceptTokenLength && !generic.has(tok)) out.add(tok);
    }
  }
  return out;
}

function hash(real: string, cfg: MaskerConfig): string {
  return shortHash(real, cfg.sessionSalt, cfg.hashLength);
}

/**
 * Mask a physical table name: preserve a recognized type prefix and/or a
 * trailing entity noun (functional shape), strip the proprietary identity,
 * append a deterministic hash.
 *   mart_ghost_job_index -> mart_<hash>
 *   dim_store_locations  -> dim_locations_<hash>
 *   job_postings         -> postings_<hash>
 *   raw_xyzcorp          -> raw_<hash>     (no entity tail recognised)
 */
export function maskTableName(real: string, cfg: MaskerConfig): string {
  const parts = tokenize(real);
  const first = parts[0];
  const last = parts[parts.length - 1];
  const prefix = first && cfg.tablePrefixes.includes(first) ? first : null;
  const tail =
    last && last !== prefix && cfg.entityNouns.includes(last) ? last : null;
  const shape = [prefix, tail].filter((p): p is string => p !== null);
  if (shape.length === 0) shape.push(cfg.fallbackTablePrefix);
  return `${shape.join("_")}_${hash(real, cfg)}`;
}

/** Mask a schema/namespace name. Schemas rarely carry useful shape; hash them. */
export function maskSchemaName(real: string, cfg: MaskerConfig): string {
  return `${cfg.schemaMaskPrefix}_${hash(real, cfg)}`;
}

/**
 * Mask a proprietary column: preserve a recognized type/measure suffix so the
 * LLM still knows the column's functional role, hash the proprietary stem.
 *   ghost_probability -> <hash>_probability
 *   internal_risk_at  -> <hash>_at
 *   secretcol         -> col_<hash>
 */
export function maskColumnName(real: string, cfg: MaskerConfig): string {
  const parts = tokenize(real);
  const last = parts[parts.length - 1];
  const suffix = last && cfg.columnSuffixes.includes(last) ? last : null;
  return suffix ? `${hash(real, cfg)}_${suffix}` : `col_${hash(real, cfg)}`;
}

/**
 * Mask a query-local alias that echoes a masked concept: replace the offending
 * concept token(s) inside the alias with a stable token mask, keeping the rest
 * of the alias's shape.
 *   median_ghost -> median_c<hash>
 *   medianGhost  -> mediancGhost-token-replaced
 *   ghost        -> c<hash>
 * Deterministic and consistent: the same concept token always maps to the same
 * replacement, so every alias that leaks it is masked the same way.
 */
export function maskAliasName(
  real: string,
  concepts: ReadonlySet<string>,
  cfg: MaskerConfig,
): string {
  // Longest tokens first so overlapping concepts replace cleanly.
  const ordered = [...concepts].sort((a, b) => b.length - a.length);
  let out = real;
  for (const tok of ordered) {
    if (tok.length === 0) continue;
    const tokenMask = `c${shortHash(tok, cfg.sessionSalt, cfg.hashLength)}`;
    out = out.replace(new RegExp(escapeRegex(tok), "gi"), tokenMask);
  }
  // If nothing changed (shouldn't happen when called only on echoing aliases),
  // fall back to a fully hashed local name so we never emit the real concept.
  return out === real ? `alias_${hash(real, cfg)}` : out;
}

/** True if a name leaks any proprietary concept token (substring, case-insensitive). */
export function echoesConcept(name: string, concepts: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  for (const tok of concepts) {
    if (tok.length > 0 && lower.includes(tok)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
