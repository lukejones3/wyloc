/**
 * Request-path SQL masking (optional, behind config.maskSql).
 *
 * A pass that runs BEFORE the detector swap (`swap-request.ts`, untouched):
 * it finds SQL in user/system text and masks proprietary identifiers + scrubs
 * sensitive literal values via @wyloc/sql-masker, folding the real↔mask pairs
 * into the same SessionStore the detector uses, so the response stream
 * rehydrates them with everything else.
 *
 * SQL it masks (per the chosen "fenced + bare-block-that-parses" policy):
 *   • the contents of ```sql … ``` fenced code blocks, and
 *   • a whole text block that looks like SQL (starts with a SQL keyword) and
 *     parses cleanly.
 * Anything that doesn't parse is left exactly as-is — the detector pass still
 * scrubs secrets in it. Mixed prose+SQL in one bare block is out of scope (v1).
 *
 * GRACEFUL DEGRADATION: if the sqlglot worker can't start (no Python / sqlglot),
 * the handle reports disabled and every call is a passthrough — the gateway
 * behaves exactly as it does today.
 */

import { SqlMasker, SqlglotWorker, resolveConfig } from "@wyloc/sql-masker";
import type { ProviderAdapter } from "./adapters/types.js";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";

export interface SqlMaskBodyOutcome {
  body: Buffer;
  processed: boolean;
  /** SQL blocks masked across the request. */
  blocks: number;
  /** Distinct real identifiers/values masked. */
  masked: number;
}

const FENCE = /```sql\b[ \t]*\r?\n([\s\S]*?)```/gi;
const SQL_START = /^\s*(with|select|insert|update|delete|create|explain|merge|alter)\b/i;

function passthrough(raw: Buffer): SqlMaskBodyOutcome {
  return { body: raw, processed: false, blocks: 0, masked: 0 };
}

/** Owns the (single, reused) sqlglot worker + masker for the gateway process. */
export class SqlMaskHandle {
  private readonly masker: SqlMasker | null;
  private readonly worker: SqlglotWorker | null;
  private readonly readyPromise: Promise<boolean>;
  private loggedDisabled = false;

  constructor(
    private readonly config: GatewayConfig,
    store: SessionStore,
    private readonly log: Logger,
  ) {
    if (!config.maskSql) {
      this.masker = null;
      this.worker = null;
      this.readyPromise = Promise.resolve(false);
      return;
    }
    let worker: SqlglotWorker | null = null;
    let masker: SqlMasker | null = null;
    let ready: Promise<boolean> = Promise.resolve(false);
    try {
      worker = new SqlglotWorker();
      // Share the store's salt so a secret seen in SQL and in prose maps to
      // the same mock as the detector pass produces.
      masker = new SqlMasker(
        resolveConfig({ dialect: config.sqlDialect, sessionSalt: store.saltValue }),
        worker,
      );
      ready = worker.ping().then(() => true).catch(() => false);
    } catch {
      ready = Promise.resolve(false);
    }
    this.worker = worker;
    this.masker = masker;
    this.readyPromise = ready;
  }

  /** Resolves true once the worker answered a ping; false if it never will. */
  ready(): Promise<boolean> {
    return this.readyPromise;
  }

  /**
   * Mask a whole string as one SQL statement (e.g. the body of a .sql file read
   * by an agentic tool), folding mappings into `store`. Public entry for the
   * file-read path; returns the rewritten text + count of masked identifiers.
   * Unparseable input comes back unchanged (n = 0).
   */
  async maskRaw(sql: string, store: SessionStore): Promise<{ out: string; n: number }> {
    return this.maskOne(sql, store);
  }

  private async maskOne(sql: string, store: SessionStore): Promise<{ out: string; n: number }> {
    if (!this.masker) return { out: sql, n: 0 };
    try {
      const r = await this.masker.mask(sql);
      const pairs = r.session.entries().map((e) => ({ real: e.real, mock: e.mask }));
      store.addPairs(pairs);
      return { out: r.masked, n: pairs.length };
    } catch {
      // Unparseable / dynamic SQL: leave untouched (detector still scrubs it).
      return { out: sql, n: 0 };
    }
  }

  /** Mask SQL within one text string. Returns the rewritten text + counts. */
  private async maskText(
    text: string,
    store: SessionStore,
  ): Promise<{ text: string; blocks: number; masked: number }> {
    if (text.length === 0) return { text, blocks: 0, masked: 0 };

    const fences = [...text.matchAll(FENCE)];
    if (fences.length > 0) {
      let out = "";
      let last = 0;
      let blocks = 0;
      let masked = 0;
      for (const m of fences) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const inner = m[1] ?? "";
        out += text.slice(last, start);
        const res = await this.maskOne(inner, store);
        out += "```sql\n" + res.out + "\n```";
        last = end;
        blocks += 1;
        masked += res.n;
      }
      out += text.slice(last);
      return { text: out, blocks, masked };
    }

    // Bare block: only attempt if it looks like SQL (cheap gate before a worker call).
    if (SQL_START.test(text)) {
      const trimmed = text.trim();
      const res = await this.maskOne(trimmed, store);
      if (res.out !== trimmed) return { text: res.out, blocks: 1, masked: res.n };
    }
    return { text, blocks: 0, masked: 0 };
  }

  /**
   * Walk a request body via `adapter`, mask SQL in the same text surfaces the
   * detector pass uses, and fold the mappings into `store`. Tool-call structure
   * is never touched (the adapter's walk skips it).
   */
  async maskBody(
    adapter: ProviderAdapter,
    raw: Buffer,
    store: SessionStore,
  ): Promise<SqlMaskBodyOutcome> {
    if (!this.config.maskSql) return passthrough(raw);
    if (!(await this.readyPromise)) {
      if (!this.loggedDisabled) {
        this.log.debug("maskSql enabled but sqlglot worker unavailable — SQL masking disabled (detector swap still active)");
        this.loggedDisabled = true;
      }
      return passthrough(raw);
    }
    if (raw.length === 0) return passthrough(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return passthrough(raw);
    }
    if (parsed === null || typeof parsed !== "object") return passthrough(raw);

    let blocks = 0;
    let masked = 0;
    await adapter.forEachText(parsed, async (text) => {
      const r = await this.maskText(text, store);
      blocks += r.blocks;
      masked += r.masked;
      return r.text;
    });

    if (blocks === 0) return { ...passthrough(raw), processed: true };
    return {
      body: Buffer.from(JSON.stringify(parsed), "utf8"),
      processed: true,
      blocks,
      masked,
    };
  }

  close(): void {
    this.worker?.close();
  }
}
