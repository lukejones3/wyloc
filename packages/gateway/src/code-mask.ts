/**
 * Request-path TS/JS code masking (optional, behind config.maskCode).
 *
 * A pass that runs BEFORE the detector swap (`swap-request.ts`, untouched) and
 * alongside the SQL masker: it finds TS/JS in user/system text and masks
 * proprietary identifiers (internal classes/functions/types/imports), internal
 * URLs/hosts/paths, and strips comments via @wyloc/code-masker, folding the
 * real↔mask pairs into the same SessionStore the detector uses so the response
 * stream rehydrates them with everything else.
 *
 * Scope (mirrors the SQL masker's fenced policy): the contents of fenced code
 * blocks tagged as TS/JS — ```ts ```tsx ```typescript ```js ```jsx
 * ```javascript ```mjs ```cjs. Bare/un-fenced code and raw file contents are
 * out of scope for v1 (masking arbitrary prose as code is unsafe); the detector
 * pass still scrubs secrets in that text.
 *
 * Unlike the SQL masker there is NO worker — masking is pure and in-process, so
 * there is nothing to fail to start and no readiness handshake. If a block
 * throws (pathological input) it is left untouched and the detector still runs.
 */

import { CodeMasker, resolveConfig } from "@wyloc/code-masker";
import type { ProviderAdapter } from "./adapters/types.js";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";

export interface CodeMaskBodyOutcome {
  body: Buffer;
  processed: boolean;
  /** TS/JS code blocks masked across the request. */
  blocks: number;
  /** Distinct real identifiers/values masked. */
  masked: number;
}

/** ```lang\n … ``` for TS/JS language tags. Captures the lang and the body. */
const FENCE =
  /```(ts|tsx|typescript|js|jsx|javascript|mjs|cjs)\b[ \t]*\r?\n([\s\S]*?)```/gi;

function langToExt(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "tsx") return "tsx";
  if (l === "jsx") return "jsx";
  if (l === "js" || l === "javascript" || l === "mjs" || l === "cjs") return "js";
  return "ts";
}

function passthrough(raw: Buffer): CodeMaskBodyOutcome {
  return { body: raw, processed: false, blocks: 0, masked: 0 };
}

/** Owns the (reused, in-process) code masker for the gateway process. */
export class CodeMaskHandle {
  private readonly masker: CodeMasker | null;

  constructor(
    private readonly config: GatewayConfig,
    store: SessionStore,
    private readonly log: Logger,
  ) {
    // Share the store's salt so a secret seen in code and in prose maps to the
    // same mock the detector pass produces — keeping rehydration consistent.
    this.masker = config.maskCode
      ? new CodeMasker(
          resolveConfig({
            sessionSalt: store.saltValue,
            maskMembers: config.maskCodeMembers,
          }),
        )
      : null;
  }

  /**
   * Mask a whole string as one TS/JS source file (e.g. the body of a .ts file
   * read by an agentic tool), folding mappings into `store`. Public entry for
   * the file-read path; returns the rewritten text + count of masked
   * identifiers/values. Pathological input comes back unchanged (n = 0).
   */
  maskRaw(code: string, fileName: string, store: SessionStore): { out: string; n: number } {
    return this.maskOne(code, fileName, store);
  }

  private maskOne(code: string, fileName: string, store: SessionStore): { out: string; n: number } {
    if (!this.masker) return { out: code, n: 0 };
    try {
      const r = this.masker.mask(code, fileName);
      const pairs = r.session.entries().map((e) => ({ real: e.real, mock: e.mask }));
      store.addPairs(pairs);
      return { out: r.masked.replace(/\s+$/, ""), n: pairs.length };
    } catch {
      // Pathological input: leave untouched (detector still scrubs secrets).
      return { out: code, n: 0 };
    }
  }

  /** Mask TS/JS within one text string. Returns the rewritten text + counts. */
  private maskText(text: string, store: SessionStore): { text: string; blocks: number; masked: number } {
    if (text.length === 0) return { text, blocks: 0, masked: 0 };

    const fences = [...text.matchAll(FENCE)];
    if (fences.length === 0) return { text, blocks: 0, masked: 0 };

    let out = "";
    let last = 0;
    let blocks = 0;
    let masked = 0;
    for (const m of fences) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const lang = m[1] ?? "ts";
      const inner = m[2] ?? "";
      out += text.slice(last, start);
      const res = this.maskOne(inner, `input.${langToExt(lang)}`, store);
      out += "```" + lang + "\n" + res.out + "\n```";
      last = end;
      blocks += 1;
      masked += res.n;
    }
    out += text.slice(last);
    return { text: out, blocks, masked };
  }

  /**
   * Walk a request body via `adapter`, mask TS/JS in the same text surfaces the
   * detector pass uses, and fold the mappings into `store`. Tool-call structure
   * is never touched (the adapter's walk skips it).
   */
  async maskBody(
    adapter: ProviderAdapter,
    raw: Buffer,
    store: SessionStore,
  ): Promise<CodeMaskBodyOutcome> {
    if (!this.config.maskCode || !this.masker) return passthrough(raw);
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
    await adapter.forEachText(parsed, (text) => {
      const r = this.maskText(text, store);
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
    // No worker to tear down; present for symmetry with SqlMaskHandle.
  }
}
