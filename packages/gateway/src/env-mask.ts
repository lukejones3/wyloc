/**
 * .env value masking.
 *
 * An .env file is nearly pure secrets: `KEY=value` lines whose VALUES are
 * sensitive by virtue of being in an env file — even when a value matches no
 * known secret pattern (internal URLs, feature-flag salts, admin codes). The
 * pattern detector alone misses these. When we're CONFIDENT a block is an env
 * file, we mask the VALUE of every assignment while keeping KEYS + structure
 * visible (the model needs to know DATABASE_URL exists and its rough shape, not
 * the real value). Values swap+rehydrate through the shared engine (store+salt).
 *
 * DETECTION is conservative-but-must-not-miss: a strong multi-signal sniff
 * (multiple KEY=value lines, env-typical comments/sections, NO code lines). Not
 * confident → leave it for the detector, which always runs regardless. Over-
 * masking a non-env block is safe (swap+rehydrate); missing a real .env is the
 * dangerous failure, so the sniff biases toward catching env files.
 *
 * SEPARATOR: `=` only (incl. `export KEY=`). `:` is NOT treated as an env
 * separator — it collides badly with YAML/code and would over-match.
 *
 * MULTILINE: single-line quoted values (incl. `=` inside, quotes, inline
 * comments) are handled; a quoted value whose closing quote is found later
 * (true multiline) is masked across the span; an UNTERMINATED quote is left
 * untouched (falls back to the detector) rather than risk mangling.
 *
 * Structure is preserved exactly — only value spans are replaced, so the output
 * remains a valid, parseable env file.
 */
import { buildSwap, type Finding } from "@wyloc/detector";
import { MaskCache } from "./mask-cache.js";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";
import type { ProviderAdapter } from "./adapters/types.js";

/** Anchored env assignment: optional `export `, a key, optional ws, `=`. */
const ENV_ASSIGN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** Any fenced code block (lang tag optional). */
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/** A non-assignment line that clearly looks like CODE (env files have none). */
function isCodeish(line: string): boolean {
  const t = line.trim();
  return (
    /[{}();]\s*$/.test(t) ||
    /=>/.test(t) ||
    /\b(function|return|class|import|require|if|for|while|switch|const|let|var)\b\s*[\w({]/.test(t)
  );
}

/**
 * Multi-signal sniff: confident the text is an env file? Requires ≥2 assignment
 * lines, NO clearly-code lines, mostly-assignments among non-comment lines, and
 * not a `;`-terminated (statement-like) block. UPPER_SNAKE keys are a positive
 * signal but not required (lowercase/mixed keys allowed).
 */
export function looksLikeEnv(text: string): boolean {
  let assign = 0, other = 0, code = 0, semicolonValues = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue; // comment
    if (line.startsWith("[") && line.endsWith("]")) continue; // [section] header
    const m = ENV_ASSIGN.exec(raw);
    if (m) {
      assign++;
      if (raw.slice(m[0].length).trim().endsWith(";")) semicolonValues++;
    } else if (isCodeish(raw)) {
      code++;
    } else {
      other++;
    }
  }
  if (assign < 2) return false;
  if (code > 0) return false; // any clear code line → not an env file
  if (semicolonValues >= assign * 0.5) return false; // mostly statement-like → code
  const candidates = assign + other; // non-blank, non-comment lines
  return assign >= candidates * 0.7; // env files are overwhelmingly assignments
}

/** Find the closing quote, honoring `\` escapes only for double quotes. */
function findClosingQuote(text: string, from: number, quote: string): number {
  const honorEscape = quote === '"';
  for (let j = from; j < text.length; j++) {
    if (honorEscape && text[j] === "\\") { j++; continue; }
    if (text[j] === quote) return j;
  }
  return -1;
}

interface ValueSpan { start: number; end: number; value: string; nextIndex: number; }

/** Parse one line's value span (absolute offsets), or null to skip the line. */
function parseValueSpan(line: string, lineStart: number, text: string): ValueSpan | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || (trimmed.startsWith("[") && trimmed.endsWith("]"))) return null;
  const m = ENV_ASSIGN.exec(line);
  if (!m) return null;

  const afterEq = lineStart + m[0].length;
  let vs = afterEq;
  while (vs < text.length && (text[vs] === " " || text[vs] === "\t")) vs++;
  const lineEndAbs = (() => { const x = text.indexOf("\n", afterEq); return x === -1 ? text.length : x; })();
  if (vs >= lineEndAbs) return null; // empty value (KEY=) — nothing to mask

  const q = text[vs];
  if (q === '"' || q === "'") {
    const close = findClosingQuote(text, vs + 1, q);
    if (close === -1) return null; // unterminated → leave to the detector
    const value = text.slice(vs + 1, close);
    const after = text.indexOf("\n", close);
    return { start: vs + 1, end: close, value, nextIndex: after === -1 ? text.length : after + 1 };
  }

  // Unquoted: value to end of line, minus an inline comment (` #…`) + trailing ws.
  let region = text.slice(vs, lineEndAbs);
  const cm = region.search(/\s#/);
  if (cm !== -1) region = region.slice(0, cm);
  region = region.replace(/\s+$/, "");
  return { start: vs, end: vs + region.length, value: region, nextIndex: lineEndAbs + 1 };
}

function mkFinding(start: number, end: number, value: string): Finding {
  return {
    layer: "structural", type: "custom", confidence: "high",
    start, end, value, environment: "unknown",
    reason: "Value in an env file.", ruleId: "env.value", maskHint: "env",
  };
}

/**
 * Mask the value of every assignment in env-file `text`, preserving keys,
 * quotes, comments, and structure. Returns the rewritten text + real→mock
 * mappings (deterministic via `salt`; the caller folds them into the store).
 */
export function maskEnvValues(text: string, salt: string): { out: string; mappings: { real: string; mock: string }[] } {
  const findings: Finding[] = [];
  let i = 0;
  while (i < text.length) {
    let nl = text.indexOf("\n", i);
    if (nl === -1) nl = text.length;
    const r = parseValueSpan(text.slice(i, nl), i, text);
    if (r && r.value.length > 0) findings.push(mkFinding(r.start, r.end, r.value));
    i = r && r.nextIndex > nl ? r.nextIndex : nl + 1;
  }
  if (findings.length === 0) return { out: text, mappings: [] };
  const { swappedText, mappings } = buildSwap(text, findings, salt);
  return { out: swappedText, mappings: mappings.map((m) => ({ real: m.real, mock: m.mock })) };
}

/**
 * Message-text env pass: mask env content the user typed/pasted — a fenced
 * block whose inner content sniffs as env, or a whole message that is an env
 * file. Mirrors the SQL/code handles (per-session content cache). The file-read
 * path uses `looksLikeEnv`/`maskEnvValues` directly via its content-router.
 */
export class EnvMaskHandle {
  readonly cache = new MaskCache();

  constructor(
    private readonly config: GatewayConfig,
    private readonly log: Logger,
  ) {}

  private maskText(text: string, store: SessionStore): { text: string; blocks: number; masked: number } {
    if (text.length === 0) return { text, blocks: 0, masked: 0 };
    return this.cache.memo(text, () => this.maskTextUncached(text, store));
  }

  private maskTextUncached(text: string, store: SessionStore): { text: string; blocks: number; masked: number } {
    const fences = [...text.matchAll(FENCE)];
    if (fences.length > 0) {
      let out = "", last = 0, blocks = 0, masked = 0;
      for (const m of fences) {
        const start = m.index ?? 0;
        const inner = m[1] ?? "";
        out += text.slice(last, start);
        if (looksLikeEnv(inner)) {
          const r = maskEnvValues(inner, store.saltValue);
          if (r.mappings.length > 0) {
            store.addPairs(r.mappings);
            const header = m[0].slice(0, m[0].indexOf("\n") + 1);
            out += header + r.out + "```";
            blocks += 1; masked += r.mappings.length;
            last = start + m[0].length;
            continue;
          }
        }
        out += m[0];
        last = start + m[0].length;
      }
      out += text.slice(last);
      return { text: out, blocks, masked };
    }

    if (looksLikeEnv(text)) {
      const r = maskEnvValues(text, store.saltValue);
      if (r.mappings.length > 0) {
        store.addPairs(r.mappings);
        return { text: r.out, blocks: 1, masked: r.mappings.length };
      }
    }
    return { text, blocks: 0, masked: 0 };
  }

  /** Mask typed/pasted env content in an ALREADY-PARSED request object, in place. */
  applyToParsed(
    adapter: ProviderAdapter,
    parsed: unknown,
    store: SessionStore,
  ): Promise<{ blocks: number; masked: number }> {
    if (!this.config.maskEnv) return Promise.resolve({ blocks: 0, masked: 0 });
    let blocks = 0, masked = 0;
    return adapter.forEachText(parsed, (text) => {
      const r = this.maskText(text, store);
      blocks += r.blocks; masked += r.masked;
      return r.text;
    }).then(() => ({ blocks, masked }));
  }

  /** Buffer→Buffer wrapper (parse + serialize). Proxy uses applyToParsed. */
  async maskBody(
    adapter: ProviderAdapter,
    raw: Buffer,
    store: SessionStore,
  ): Promise<{ body: Buffer; processed: boolean; blocks: number; masked: number }> {
    const passthrough = { body: raw, processed: false, blocks: 0, masked: 0 };
    if (raw.length === 0) return passthrough;
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { return passthrough; }
    if (parsed === null || typeof parsed !== "object") return passthrough;

    const { blocks, masked } = await this.applyToParsed(adapter, parsed, store);
    if (blocks === 0) return { ...passthrough, processed: true };
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), processed: true, blocks, masked };
  }
}
