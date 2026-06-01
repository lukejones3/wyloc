/**
 * Minimal operational logger.
 *
 * PRIVACY CONTRACT: this logger is for non-sensitive operational
 * metadata ONLY — method, path, status, timing, finding *counts* and
 * *types*. It must NEVER be passed a secret value, a prompt body, or a
 * mock↔real mapping. The detector's `Finding.type` (coarse class) is the
 * most specific thing that may ever be logged.
 */

import type { GatewayConfig } from "./config.js";

const PREFIX = "[wyloc-gateway]";

export class Logger {
  constructor(private readonly verbose: boolean) {}

  static from(config: GatewayConfig): Logger {
    return new Logger(config.verbose);
  }

  /** Always-on line (startup, errors). */
  info(msg: string): void {
    console.error(`${PREFIX} ${msg}`);
  }

  /** Verbose-only operational line. */
  debug(msg: string): void {
    if (this.verbose) console.error(`${PREFIX} ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    console.error(`${PREFIX} ERROR ${msg}${detail}`);
  }
}
