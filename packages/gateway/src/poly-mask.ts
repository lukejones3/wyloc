/**
 * Request-path multi-language code masking (Go/Java/C#/Kotlin/Python), behind
 * the per-language `languages` config (wyloc.json) / WYLOC_MASK_LANGUAGES env.
 *
 * The @wyloc/poly-masker sibling of code-mask.ts: masks proprietary
 * identifiers (internal types/functions/packages), internal import paths,
 * internal URLs/hosts/paths in literals, strips comments, and swaps hardcoded
 * secrets — folding real↔mask pairs into the same SessionStore the detector
 * uses, so one rehydration pass reverses everything.
 *
 * Two surfaces, mirroring the TS/JS handle:
 *   • Fenced blocks in message text (```go ```java ```kotlin ```cs ```py …)
 *   • Raw file bodies via the file-read content-router (sniffContent + maskRaw)
 *
 * Internal-vs-external classification comes from each language's import/
 * package system against `internalPackagePrefixes` (wyloc.json), augmented by
 * manifest auto-discovery (go.mod, …) from the project root.
 *
 * GRACEFUL DEGRADATION: content that doesn't parse cleanly (or a rewrite that
 * fails re-parse verification) comes back unchanged (n = 0) and the caller's
 * detector pass still scrubs secrets. A request is never failed for this.
 */

import { createHash } from "node:crypto";
import {
  PolyMasker,
  ProjectIndex,
  discoverInternalPrefixes,
  setGrammarDir,
  IMPLEMENTED_LANGUAGES,
  type LanguageId,
} from "@wyloc/poly-masker";
import { bundledWasmDir } from "./runtime.js";
import type { ProviderAdapter } from "./adapters/types.js";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./session.js";

export interface PolyMaskBodyOutcome {
  body: Buffer;
  processed: boolean;
  /** Fenced blocks masked across the request. */
  blocks: number;
  /** Distinct real identifiers/values masked. */
  masked: number;
}

/** Fence tags per language (```go … ```py). */
const FENCE_LANG: Record<string, LanguageId> = {
  go: "go",
  golang: "go",
  java: "java",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  csharp: "csharp",
  cs: "csharp",
  "c#": "csharp",
  python: "python",
  py: "python",
  cobol: "cobol",
  cbl: "cobol",
  cob: "cobol",
  rust: "rust",
  rs: "rust",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  c: "c",
  h: "c",
};

// NOTE: bare `c` must stay LAST in the alternation (it would otherwise
// shadow cobol/csharp/cs/cpp/cc/cxx as a prefix match).
const FENCE = /```(go|golang|java|kotlin|kts?|csharp|cs|c#|python|py|cobol|cbl|cob|rust|rs|cpp|c\+\+|cc|cxx|hpp|h|c)\b[ \t]*\r?\n([\s\S]*?)```/gi;

/**
 * High-specificity per-language sniffs for RAW file content. Deliberately
 * stricter than the TS/JS `looksLikeCode` — a false route costs a wasted parse
 * (adopt-only-if-masked protects the content), but a sniff that overlaps
 * TS/JS would steal files from the more capable TS masker.
 */
const SNIFFS: [LanguageId, (s: string) => boolean][] = [
  // COBOL first: nothing else on earth says IDENTIFICATION DIVISION.
  ["cobol", (s) => /IDENTIFICATION\s+DIVISION/i.test(s) && /PROGRAM-ID/i.test(s)],
  ["go", (s) => /(^|\n)package\s+[A-Za-z_]\w*\s*(\r?\n|$)/.test(s) && /(^|\n)func\s/.test(s)],
  // The `package x.y;` SEMICOLON separates Java from Kotlin; TS/JS have no
  // package statement at all. (A packageless Java snippet falls through to
  // the TS/JS branch — gray zone, documented.)
  ["java", (s) => /(^|\n)package\s+[\w.]+\s*;/.test(s) && /\b(class|interface|enum|record)\s+[A-Z]/.test(s)],
  // C#: a namespace declaration, or `using Dotted.Path;` directives (distinct
  // from Java's `import` and TS's `import … from`).
  [
    "csharp",
    (s) =>
      (/(^|\n)\s*namespace\s+[A-Z][\w.]*/.test(s) || /(^|\n)using\s+[A-Z][\w.]*\s*;/.test(s)) &&
      /\b(class|record|struct|interface|enum)\s+[A-Z]/.test(s),
  ],
  // Kotlin: a package line WITHOUT a semicolon (Java's has one; Go files were
  // already claimed above because they contain `func`, Kotlin has `fun`).
  [
    "kotlin",
    (s) => /(^|\n)package\s+[\w.]+[ \t]*(\r?\n|$)/.test(s) && /\b(fun|val|data class|object)\s/.test(s),
  ],
  // Rust: `use path::to::thing;` (double-colon paths are unmistakable) or a
  // `fn` + `let mut`/`impl` combination.
  [
    "rust",
    (s) => /(^|\n)use\s+[\w:]+::[\w:{}, *]+;/.test(s) && /\bfn\s+\w+/.test(s),
  ],
  // C++: #include plus unmistakable C++ markers — MUST run before the C
  // sniff (which explicitly rejects these markers).
  [
    "cpp",
    (s) =>
      /(^|\n)#include\s+[<"]/.test(s) &&
      /\b(namespace|template)\s|std::|#include\s+<(iostream|vector|string|map|memory)>|\bclass\s+[A-Z]/.test(s),
  ],
  // C: #include lines WITHOUT any C++ markers (namespace/template/class/
  // std:: / C++ headers) — the C++ sniff above claims those files instead.
  [
    "c",
    (s) =>
      /(^|\n)#include\s+[<"]/.test(s) &&
      /(^|\n)\s*(static\s+|const\s+|unsigned\s+|struct\s+|typedef\s+|int\s+|void\s+|char\s+)/.test(s) &&
      !/\b(namespace|template)\s|std::|#include\s+<(iostream|vector|string|map|memory)>|\bclass\s+[A-Z]/.test(s),
  ],
  // Python: `from x import y` / bare `import x` lines (no braces/semicolons —
  // TS imports have `from "…"` with quotes) plus a def/class. A plain script
  // with no def/class falls through to detector-only (gray zone, documented).
  [
    "python",
    (s) =>
      (/(^|\n)from\s+[\w.]+\s+import\s+[\w*]/.test(s) || /(^|\n)import\s+[\w.]+(\s+as\s+\w+)?[ \t]*(\r?\n|$)/.test(s)) &&
      /(^|\n)(def|class)\s+\w+.*:/.test(s),
  ],
];

/** Merge config prefixes over discovered ones (both contribute; config wins on order). */
function mergePrefixes(
  discovered: Partial<Record<LanguageId, string[]>>,
  configured: Readonly<Partial<Record<LanguageId, readonly string[]>>>,
): Partial<Record<LanguageId, string[]>> {
  const out: Partial<Record<LanguageId, string[]>> = { ...discovered };
  for (const [lang, prefixes] of Object.entries(configured) as [LanguageId, string[]][]) {
    out[lang] = [...new Set([...(prefixes ?? []), ...(out[lang] ?? [])])];
  }
  return out;
}

/** Owns the (reused, in-process) multi-language masker for the gateway process. */
export class PolyMaskHandle {
  private readonly masker: PolyMasker | null;
  private readonly languages: LanguageId[];
  private readonly prefixes: Partial<Record<LanguageId, string[]>>;
  /**
   * Project symbol index (lazy, per language): sibling-file type names in
   * internal namespaces/packages — closes the C#-usings / same-package gap
   * when the gateway runs next to the repo (projectRoot). Fail-open.
   */
  private readonly index: ProjectIndex;
  /** Per-session content cache (re-sent history / re-read files are O(1)). */
  private readonly cache = new Map<string, { out: string; n: number }>();

  constructor(
    private readonly config: GatewayConfig,
    store: SessionStore,
    private readonly log: Logger,
  ) {
    this.languages = config.maskLanguages.filter((l): l is LanguageId =>
      (IMPLEMENTED_LANGUAGES as string[]).includes(l),
    );
    // Standalone binary: grammars ship in runtime/wasm next to the executable
    // (no node_modules to resolve from). Must be set before the first parse.
    const wasmDir = bundledWasmDir();
    if (wasmDir) setGrammarDir(wasmDir);
    this.prefixes = mergePrefixes(
      discoverInternalPrefixes(config.projectRoot),
      config.internalPackagePrefixes,
    );
    this.index = new ProjectIndex(config.projectRoot);
    this.masker =
      this.languages.length > 0
        ? PolyMasker.create({
            languages: this.languages,
            internalPackagePrefixes: this.prefixes,
            sessionSalt: store.saltValue,
            internalDomains: config.internalDomains,
            internalTlds: config.internalTlds,
            detectorConfig: config.detector,
            ...(config.blocklistSubstrings.length > 0
              ? { maskBucket2: true, bucket2Substrings: config.blocklistSubstrings }
              : {}),
          })
        : null;
  }

  get enabled(): boolean {
    return this.masker !== null;
  }

  /** Which enabled language this raw file content sniffs as, if any. */
  sniffContent(text: string): LanguageId | null {
    if (!this.masker) return null;
    for (const [lang, sniff] of SNIFFS) {
      if (this.languages.includes(lang) && sniff(text)) return lang;
    }
    return null;
  }

  /**
   * Mask a whole string as one source file of `lang`, folding mappings into
   * `store`. Entry point for the file-read content-router. Unparseable /
   * unverifiable content comes back unchanged (n = 0).
   */
  async maskRaw(code: string, lang: LanguageId, store: SessionStore): Promise<{ out: string; n: number }> {
    if (!this.masker) return { out: code, n: 0 };
    const key = createHash("sha256").update(`${lang} ${code}`).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    let rec: { out: string; n: number };
    try {
      const extra = await this.index.internalTypes(lang, this.prefixes[lang] ?? []);
      const r = await this.masker.mask(code, lang, extra);
      const pairs = r.session.entries().map((e) => ({ real: e.real, mock: e.mask }));
      store.addPairs(pairs);
      rec = { out: r.masked.replace(/\s+$/, ""), n: pairs.length };
    } catch {
      // Parse/verification failure: leave untouched (detector still runs).
      rec = { out: code, n: 0 };
    }
    this.cache.set(key, rec);
    return rec;
  }

  /** Mask fenced blocks within one text string. */
  private async maskText(
    text: string,
    store: SessionStore,
  ): Promise<{ text: string; blocks: number; masked: number }> {
    const fences = [...text.matchAll(FENCE)];
    if (fences.length === 0) return { text, blocks: 0, masked: 0 };

    let out = "";
    let last = 0;
    let blocks = 0;
    let masked = 0;
    for (const m of fences) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const tag = (m[1] ?? "").toLowerCase();
      const lang = FENCE_LANG[tag];
      const inner = m[2] ?? "";
      out += text.slice(last, start);
      if (lang && this.languages.includes(lang)) {
        const res = await this.maskRaw(inner, lang, store);
        out += "```" + m[1] + "\n" + res.out + "\n```";
        if (res.n > 0) {
          blocks += 1;
          masked += res.n;
        }
      } else {
        out += m[0];
      }
      last = end;
    }
    out += text.slice(last);
    return { text: out, blocks, masked };
  }

  /** Mask fenced code in an ALREADY-PARSED request object, in place. */
  async applyToParsed(
    adapter: ProviderAdapter,
    parsed: unknown,
    store: SessionStore,
  ): Promise<{ blocks: number; masked: number }> {
    if (!this.masker) return { blocks: 0, masked: 0 };
    let blocks = 0;
    let masked = 0;
    await adapter.forEachText(parsed, async (text) => {
      if (text.length === 0) return text;
      const r = await this.maskText(text, store);
      blocks += r.blocks;
      masked += r.masked;
      return r.text;
    });
    return { blocks, masked };
  }

  /** Buffer→Buffer wrapper (parse + serialize). Proxy uses applyToParsed. */
  async maskBody(
    adapter: ProviderAdapter,
    raw: Buffer,
    store: SessionStore,
  ): Promise<PolyMaskBodyOutcome> {
    const passthrough: PolyMaskBodyOutcome = { body: raw, processed: false, blocks: 0, masked: 0 };
    if (raw.length === 0 || !this.masker) return passthrough;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return passthrough;
    }
    if (parsed === null || typeof parsed !== "object") return passthrough;

    const { blocks, masked } = await this.applyToParsed(adapter, parsed, store);
    if (blocks === 0) return { ...passthrough, processed: true };
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), processed: true, blocks, masked };
  }

  close(): void {
    // No worker to tear down; present for symmetry with the other handles.
  }
}
