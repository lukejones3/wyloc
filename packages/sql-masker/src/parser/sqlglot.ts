import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Classification } from "../types.js";
import type { Renames, SqlParser } from "./types.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  id: number | null;
  ok: boolean;
  result?: unknown;
  error?: string;
  fatal?: boolean;
}

export interface SqlglotWorkerOptions {
  pythonPath?: string;
  workerPath?: string;
}

function defaultWorkerPath(): string {
  // src/parser/sqlglot.ts -> ../../python ; dist/parser/sqlglot.js -> ../../python
  return fileURLToPath(new URL("../../python/worker.py", import.meta.url));
}

/**
 * SqlParser backed by a persistent sqlglot Python sidecar.
 *
 * One subprocess is spawned and reused for the lifetime of the worker, so the
 * interpreter+import cost (~50ms) is paid once and each subsequent parse is a
 * few ms. Communication is newline-delimited JSON over stdin/stdout. SQL only
 * ever travels over the pipe — never written to disk, never logged here.
 */
export class SqlglotWorker implements SqlParser {
  private readonly proc: ChildProcess;
  private readonly rl: Interface;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private fatal: Error | null = null;

  constructor(options: SqlglotWorkerOptions = {}) {
    const pythonPath = options.pythonPath ?? "python3";
    const workerPath = options.workerPath ?? defaultWorkerPath();

    this.proc = spawn(pythonPath, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (err) => this.failAll(err));
    this.proc.on("exit", (code) => {
      if (!this.closed) {
        this.failAll(new Error(`sql-masker worker exited unexpectedly (code ${code})`));
      }
    });
    // Drain stderr so the pipe can't fill; do not surface SQL-bearing content.
    this.proc.stderr?.on("data", () => {});

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error("sql-masker worker: failed to open stdio pipes");
    }
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
  }

  private onLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    let msg: WorkerResponse;
    try {
      msg = JSON.parse(line) as WorkerResponse;
    } catch {
      return; // ignore non-JSON noise
    }
    if (msg.fatal && msg.ok === false) {
      this.failAll(new Error(msg.error ?? "worker fatal error"));
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "worker error"));
  }

  private failAll(err: Error): void {
    this.fatal = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.closed) return Promise.reject(new Error("sql-masker worker is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  classify(sql: string, dialect: string): Promise<Classification> {
    return this.request<Classification>({ op: "classify", sql, dialect });
  }

  async extractLiterals(sql: string, dialect: string): Promise<string[]> {
    const result = await this.request<{ literals: string[] }>({
      op: "literals",
      sql,
      dialect,
    });
    return result.literals;
  }

  async rewrite(
    sql: string,
    dialect: string,
    renames: Renames,
    stripComments: boolean,
  ): Promise<string> {
    const result = await this.request<{ sql: string }>({
      op: "rewrite",
      sql,
      dialect,
      tables: renames.tables,
      schemas: renames.schemas,
      columns: renames.columns,
      identifiers: renames.identifiers,
      literals: renames.literals,
      stripComments,
    });
    return result.sql;
  }

  /** Liveness/diagnostic check; resolves with the worker's sqlglot version. */
  ping(): Promise<{ pong: boolean; sqlglot: string }> {
    return this.request({ op: "ping" });
  }

  close(): void {
    this.closed = true;
    try { this.rl.close(); } catch { /* noop */ }
    try { this.proc.stdin?.end(); } catch { /* noop */ }
    try { this.proc.kill(); } catch { /* noop */ }
  }
}
