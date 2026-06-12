import { resolveConfig, type MaskerConfig, type MaskerConfigInput } from "./config.js";
import {
  conceptTokens,
  echoesConcept,
  maskAliasName,
  maskColumnName,
  maskSchemaName,
  maskTableName,
} from "./mask.js";
import { rehydrate } from "./rehydrate.js";
import { SessionMap } from "./session.js";
import { SqlglotWorker } from "./parser/sqlglot.js";
import type { Renames, SqlParser } from "./parser/types.js";
import type { Classification } from "./types.js";

/** Outcome of masking one query. `session` is RAM-only and drives rehydration. */
export interface MaskResult {
  masked: string;
  session: SessionMap;
  dialect: string;
  // Inspection surface (useful for tests/audit; reveals nothing beyond `session`).
  maskedTables: string[];
  maskedSchemas: string[];
  maskedColumns: string[];
  maskedAliases: string[];
  preservedCtes: string[];
  conceptTokens: string[];
}

function isExplicitlyProprietary(col: string, cfg: MaskerConfig): boolean {
  for (const rule of cfg.proprietaryColumns) {
    if (typeof rule === "string") {
      if (rule === col) return true;
    } else if (rule.test(col)) {
      return true;
    }
  }
  return false;
}

/**
 * The masking engine. Holds a parser (a sqlglot worker by default) and a
 * resolved policy. Reuse one instance across many queries to keep the worker
 * warm; call close() when done.
 */
export class SqlMasker {
  private readonly parser: SqlParser;
  private readonly config: MaskerConfig;
  private readonly ownsParser: boolean;

  constructor(config: MaskerConfig, parser?: SqlParser) {
    this.config = config;
    if (parser) {
      this.parser = parser;
      this.ownsParser = false;
    } else {
      this.parser = new SqlglotWorker({
        pythonPath: config.pythonPath,
        workerPath: config.workerPath,
      });
      this.ownsParser = true;
    }
  }

  /** Convenience constructor: resolve config + spin up a worker. */
  static create(input?: MaskerConfigInput, parser?: SqlParser): SqlMasker {
    return new SqlMasker(resolveConfig(input), parser);
  }

  async mask(sql: string): Promise<MaskResult> {
    const cfg = this.config;
    const c: Classification = await this.parser.classify(sql, cfg.dialect);
    const session = new SessionMap();

    const tables: Record<string, string> = {};
    const schemas: Record<string, string> = {};
    const columns: Record<string, string> = {};
    const identifiers: Record<string, string> = {};
    const maskedTables: string[] = [];
    const maskedSchemas: string[] = [];
    const maskedColumns: string[] = [];
    const maskedAliases: string[] = [];

    // 1. Physical tables + their schemas → masked, and they seed the concepts.
    const realProprietary: string[] = [];
    if (cfg.maskTables) {
      for (const t of c.physicalTables) {
        if (!(t.name in tables)) {
          tables[t.name] = session.add("table", t.name, maskTableName(t.name, cfg));
          maskedTables.push(t.name);
          realProprietary.push(t.name);
        }
      }
    }
    if (cfg.maskSchemas) {
      for (const t of c.physicalTables) {
        const s = t.schema;
        if (s && !(s in schemas)) {
          schemas[s] = session.add("schema", s, maskSchemaName(s, cfg));
          maskedSchemas.push(s);
          realProprietary.push(s);
        }
      }
    }

    // 2. Proprietary columns: explicit config flags + concept-token auto-detect.
    const explicitCols = c.columns.filter((col) => isExplicitlyProprietary(col, cfg));
    let concepts = conceptTokens([...realProprietary, ...explicitCols], cfg);
    if (cfg.maskColumns) {
      for (const col of c.columns) {
        const explicit = isExplicitlyProprietary(col, cfg);
        const auto =
          cfg.autoMaskConceptColumns &&
          !cfg.genericColumns.includes(col) &&
          echoesConcept(col, concepts);
        if ((explicit || auto) && !(col in columns)) {
          columns[col] = session.add("column", col, maskColumnName(col, cfg));
          maskedColumns.push(col);
        }
      }
      // Masked columns can introduce new proprietary stems (e.g. ghost_probability).
      concepts = conceptTokens([...realProprietary, ...explicitCols, ...maskedColumns], cfg);
    }

    // 3. Concept-echo local names (aliases AND CTE names) → masked consistently.
    //    Non-echoing CTE names / aliases are left untouched.
    if (cfg.maskConceptEchoAliases) {
      for (const name of [...c.aliases, ...c.cteNames]) {
        if (!(name in identifiers) && echoesConcept(name, concepts)) {
          identifiers[name] = session.add("alias", name, maskAliasName(name, concepts, cfg));
          maskedAliases.push(name);
        }
      }
    }

    const renames: Renames = { tables, schemas, columns, identifiers };
    const masked = await this.parser.rewrite(sql, cfg.dialect, renames, cfg.stripComments);

    return {
      masked,
      session,
      dialect: cfg.dialect,
      maskedTables,
      maskedSchemas,
      maskedColumns,
      maskedAliases,
      preservedCtes: c.cteNames.filter((n) => !(n in identifiers)),
      conceptTokens: [...concepts],
    };
  }

  /** Reverse a masked LLM response using a session map. Pure; parser not needed. */
  rehydrate(text: string, session: SessionMap): string {
    return rehydrate(text, session);
  }

  close(): void {
    if (this.ownsParser) this.parser.close();
  }
}
