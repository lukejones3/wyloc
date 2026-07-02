/**
 * Request-path masking of FILE-READ content (optional, behind config.maskFileReads).
 *
 * Claude Code / Codex read files on their own and send the contents to the model
 * inside tool results — Anthropic `tool_result` blocks, OpenAI `role:"tool"`
 * messages. Until now those were walked by nothing and forwarded byte-intact (a
 * real leak channel: a read `.env` reached the provider verbatim). This pass
 * masks that text the SAME way typed text is masked, sharing the one session
 * store + salt so masks stay consistent across typed AND file content.
 *
 * Per tool-result string:
 *   1. STRUCTURAL (optional, sniff + own toggle): if it looks like SQL and
 *      WYLOC_MASK_SQL is on → @wyloc/sql-masker; else if it looks like TS/JS and
 *      WYLOC_MASK_CODE is on → @wyloc/code-masker. A structural masker's output
 *      is ADOPTED only if it actually masked something — so a plain-text file a
 *      sniff misroutes can never be corrupted (it falls through unchanged).
 *   2. DETECTOR (always, unconditional): @wyloc/detector scan + buildSwap over
 *      the (possibly structurally-masked) text. This is the core win — secrets /
 *      PII in ANY file, including .env / config / JSON / logs that sniff as
 *      neither SQL nor code.
 *
 * STRUCTURE IS NEVER TOUCHED: the adapter hands us only tool-result TEXT; ids,
 * names, arguments, and non-text blocks never reach this code.
 *
 * PERFORMANCE: conversation history re-sends the same file every turn. A
 * per-session content-hash cache makes a repeated file O(1) (no re-parse,
 * no re-scan) while still reporting whether it carried a secret mock, so the
 * echo directive is injected on every turn that forwards one.
 *
 * GRACEFUL DEGRADATION: any parser/throw on one string falls back to
 * detector-only for that string; a request is never failed for this reason.
 */

import { createHash } from "node:crypto";
import { scan, buildSwap } from "@wyloc/detector";
import { looksLikeEnv, maskEnvValues } from "./env-mask.js";
import { MOCK_MARKER } from "./swap-request.js";
import type { ProviderAdapter } from "./adapters/types.js";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";
import type { SqlMaskHandle } from "./sql-mask.js";
import type { CodeMaskHandle } from "./code-mask.js";
import type { PolyMaskHandle } from "./poly-mask.js";

export interface FileReadMaskOutcome {
  body: Buffer;
  processed: boolean;
  /** Tool-result strings that were masked (changed) this request. */
  files: number;
  /** Distinct real identifiers/values masked this request (new work). */
  masked: number;
  /** Whether any forwarded tool-result carries a WYLOC_MOCK_ secret placeholder. */
  hasSecretMock: boolean;
}

interface MaskRecord {
  out: string;
  masked: number;
  hasSecretMock: boolean;
}

/** Strip leading SQL comments/whitespace, then test for a statement keyword. */
function looksLikeSql(s: string): boolean {
  const t = s.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "");
  return /^(with|select|insert|update|delete|create|alter|merge|explain|drop|truncate)\b/i.test(t);
}

/** Cheap high-confidence pre-filter for TS/JS before invoking the TS parser. */
function looksLikeCode(s: string): boolean {
  return (
    /(^|\n)\s*(import\b[^\n]*\bfrom\b|export\b|class\s+[A-Za-z_$]|interface\s+[A-Za-z_$]|function\s+[A-Za-z_$]|enum\s+[A-Za-z_$]|type\s+[A-Za-z_$][\w$]*\s*=)/.test(s) ||
    /=>/.test(s)
  );
}

/** JSX present → parse as .tsx so the TS parser doesn't choke on tags. */
function codeFileName(s: string): string {
  return /<[A-Za-z][\w-]*[\s/>]/.test(s) ? "input.tsx" : "input.ts";
}

function passthrough(raw: Buffer): FileReadMaskOutcome {
  return { body: raw, processed: false, files: 0, masked: 0, hasSecretMock: false };
}

/** Orchestrates the three passes over tool-result text. Pure of any worker it owns. */
export class FileReadMaskHandle {
  private readonly cache = new Map<string, MaskRecord>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly sqlMask: SqlMaskHandle | null,
    private readonly codeMask: CodeMaskHandle | null,
    private readonly log: Logger,
    // Trailing + optional: existing call sites (and tests) stay valid.
    private readonly polyMask: PolyMaskHandle | null = null,
  ) {}

  private async maskContent(text: string, store: SessionStore, sqlReady: boolean): Promise<MaskRecord> {
    if (text.length === 0) return { out: text, masked: 0, hasSecretMock: false };

    // Cache: a re-sent file is O(1). Counts are preserved so the directive is
    // (re)injected on every turn that forwards a secret mock.
    const key = createHash("sha256").update(text).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;

    let out = text;
    let masked = 0;

    // 1. STRUCTURAL — sniff + own toggle; adopt only if it actually masked.
    // env first: an .env is the most dangerous file an agent reads, and its
    // sniff is the most specific (a real .env isn't SQL or code).
    try {
      if (this.config.maskEnv && looksLikeEnv(out)) {
        const r = maskEnvValues(out, store.saltValue);
        if (r.mappings.length > 0) {
          store.addPairs(r.mappings);
          out = r.out;
          masked += r.mappings.length;
        }
      } else if (this.config.maskSql && sqlReady && this.sqlMask && looksLikeSql(out)) {
        const r = await this.sqlMask.maskRaw(out, store);
        if (r.n > 0) {
          out = r.out;
          masked += r.n;
        }
      } else if (this.config.maskCode && this.codeMask && looksLikeCode(out)) {
        const r = this.codeMask.maskRaw(out, codeFileName(out), store);
        if (r.n > 0) {
          out = r.out;
          masked += r.n;
        }
      } else if (this.polyMask?.enabled) {
        // Go/Java/C#/Kotlin/Python — per-language sniffs are stricter than the
        // TS one above, and adopt-only-if-masked still protects a misroute.
        const lang = this.polyMask.sniffContent(out);
        if (lang) {
          const r = await this.polyMask.maskRaw(out, lang, store);
          if (r.n > 0) {
            out = r.out;
            masked += r.n;
          }
        }
      }
    } catch {
      // Structural parse failed — keep `out` as-is; detector still runs below.
      out = text;
    }

    // 2. DETECTOR — ALWAYS, regardless of sniff result. Catches secrets/PII in
    //    plain config/.env/log files that are neither SQL nor code.
    try {
      const { findings: raw } = scan(out, this.config.detector);
      // Skip any finding that matched an existing WYLOC_MOCK_ placeholder a
      // structural pass (env/SQL/code) just wrote — re-masking it would chain
      // mock-of-a-mock, which one rehydration pass can't reverse.
      const findings = raw.filter((f) => !f.value.includes(MOCK_MARKER));
      if (findings.length > 0) {
        const swap = buildSwap(out, findings, store.saltValue);
        out = swap.swappedText;
        store.add(swap.mappings);
        masked += swap.mappings.length;
      }
    } catch {
      /* detector should never throw; be safe and forward what we have */
    }

    const rec: MaskRecord = { out, masked, hasSecretMock: out.includes("WYLOC_MOCK_") };
    this.cache.set(key, rec);
    return rec;
  }

  /**
   * Mask the text payload of every tool result in `raw`, folding mappings into
   * `store`. The adapter exposes only tool-result TEXT, so structure is safe.
   */
  /** Mask tool-result content in an ALREADY-PARSED request object, in place. */
  async applyToParsed(
    adapter: ProviderAdapter,
    parsed: unknown,
    store: SessionStore,
  ): Promise<{ files: number; masked: number; hasSecretMock: boolean }> {
    if (!this.config.maskFileReads) return { files: 0, masked: 0, hasSecretMock: false };
    const sqlReady = this.config.maskSql && this.sqlMask ? await this.sqlMask.ready() : false;
    let files = 0;
    let masked = 0;
    let hasSecretMock = false;
    await adapter.forEachToolResultText(parsed, async (text) => {
      const rec = await this.maskContent(text, store, sqlReady);
      if (rec.out !== text) files += 1;
      masked += rec.masked;
      if (rec.hasSecretMock) hasSecretMock = true;
      return rec.out;
    });
    return { files, masked, hasSecretMock };
  }

  /** Buffer→Buffer wrapper (parse + serialize). Proxy uses applyToParsed. */
  async maskBody(
    adapter: ProviderAdapter,
    raw: Buffer,
    store: SessionStore,
  ): Promise<FileReadMaskOutcome> {
    if (raw.length === 0) return passthrough(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return passthrough(raw);
    }
    if (parsed === null || typeof parsed !== "object") return passthrough(raw);

    const { files, masked, hasSecretMock } = await this.applyToParsed(adapter, parsed, store);
    if (files === 0 && !hasSecretMock) return { ...passthrough(raw), processed: true };
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), processed: true, files, masked, hasSecretMock };
  }
}
