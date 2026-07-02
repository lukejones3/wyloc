import { scan, buildSwap } from "@wyloc/detector";
import { SessionMap, maskStringValue, rehydrate } from "@wyloc/code-masker";
import { resolveConfig, type PolyMaskerConfig, type PolyMaskerConfigInput } from "./config.js";
import { shortHash } from "./hash.js";
import { analyzeGo } from "./languages/go.js";
import { analyzeJava } from "./languages/java.js";
import { parserFor } from "./parsers.js";
import { countParseErrors } from "./tree.js";
import type { Analyzer, AnalyzerCtx, IdentifierKind, LanguageId, MaskKind, Span } from "./types.js";

/** Same shape as @wyloc/code-masker's MaskResult so gateway handles stay uniform. */
export interface MaskResult {
  masked: string;
  session: SessionMap;
  maskedIdentifiers: { real: string; mask: string; kind: MaskKind }[];
  maskedStrings: { real: string; mask: string }[];
  maskedModuleSpecifiers: { real: string; mask: string }[];
  swappedSecrets: { mock: string }[];
}

/** Thrown when input doesn't parse cleanly or the rewrite failed verification. */
export class PolyMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolyMaskError";
  }
}

const ANALYZERS: Partial<Record<LanguageId, Analyzer>> = {
  go: analyzeGo,
  java: analyzeJava,
};

/** Languages with an implemented analyzer (config may enable fewer). */
export const IMPLEMENTED_LANGUAGES = Object.keys(ANALYZERS) as LanguageId[];

/** Identifier-mask prefixes — same vocabulary as @wyloc/code-masker's mask.ts. */
const ID_PREFIX: Record<IdentifierKind, string> = {
  class: "Class",
  function: "fn",
  interface: "Interface",
  type: "Type",
  enum: "Enum",
  namespace: "Mod",
  member: "m",
  import: "Import",
};

interface Edit extends Span {
  text: string;
}

/** The detector's reserved placeholder marker (idempotency invariant). */
const MOCK_MARKER = "WYLOC_MOCK_";

/**
 * The multi-language masker. One instance per gateway process; grammars load
 * lazily per language on first use. `mask()` throws PolyMaskError on content
 * it can't handle SAFELY (parse errors in, parse errors out) — callers treat
 * that as "fall back to detector-only", never as a failed request.
 */
export class PolyMasker {
  private readonly config: PolyMaskerConfig;

  constructor(config: PolyMaskerConfig) {
    this.config = config;
  }

  static create(input?: PolyMaskerConfigInput): PolyMasker {
    return new PolyMasker(resolveConfig(input));
  }

  languageEnabled(lang: LanguageId): boolean {
    return this.config.languages.includes(lang) && lang in ANALYZERS;
  }

  async mask(
    code: string,
    lang: LanguageId,
    extraInternalTypes: ReadonlySet<string> = new Set(),
  ): Promise<MaskResult> {
    const cfg = this.config;
    const analyzer = ANALYZERS[lang];
    if (!analyzer || !this.languageEnabled(lang)) {
      throw new PolyMaskError(`language not enabled: ${lang}`);
    }

    const parser = await parserFor(lang);
    const tree = parser.parse(code);
    if (!tree) throw new PolyMaskError("parser returned no tree");
    // A file that doesn't parse cleanly can't be classified reliably — bail
    // (the caller's detector pass still scrubs secrets in it).
    if (countParseErrors(tree.rootNode) > 0) {
      throw new PolyMaskError(`input does not parse cleanly as ${lang}`);
    }

    const ctx: AnalyzerCtx = {
      src: code,
      prefixes: cfg.internalPackagePrefixes[lang] ?? [],
      extraInternalTypes,
      hash: (s) => shortHash(s, cfg.sessionSalt, cfg.hashLength),
      maskId: (real, kind) => `${ID_PREFIX[kind]}_${shortHash(real, cfg.sessionSalt, cfg.hashLength)}`,
    };
    const analysis = analyzer(tree.rootNode, ctx);

    const session = new SessionMap();
    const maskedIdentifiers: MaskResult["maskedIdentifiers"] = [];
    const maskedStrings: MaskResult["maskedStrings"] = [];
    const maskedModuleSpecifiers: MaskResult["maskedModuleSpecifiers"] = [];
    const edits: Edit[] = [];

    // 1. Symbol renames. The session may suffix a mask on collision — splice
    //    the STORED value so every reference stays consistent. Never re-mask
    //    text that carries a detector placeholder (idempotency invariant).
    for (const sym of analysis.symbols) {
      if (sym.spans.length === 0) continue;
      if (sym.real.includes(MOCK_MARKER)) continue;
      const stored = session.add(sym.kind, sym.real, sym.mask);
      for (const span of sym.spans) edits.push({ ...span, text: stored });
      if (sym.kind === "module-specifier") {
        maskedModuleSpecifiers.push({ real: sym.real, mask: stored });
      } else {
        maskedIdentifiers.push({ real: sym.real, mask: stored, kind: sym.kind });
      }
    }

    // 2. String literals: reuse the code-masker's internal-infrastructure pass.
    if (cfg.strings.maskStrings || cfg.strings.maskBucket2) {
      for (const str of analysis.strings) {
        if (str.text.includes(MOCK_MARKER)) continue; // already masked by a prior pass
        const res = maskStringValue(str.text, cfg.strings);
        if (res.hits.length === 0) continue;
        let value = res.value;
        for (const hit of res.hits) {
          const stored = session.add(hit.kind, hit.real, hit.mask);
          if (stored !== hit.mask) value = value.split(hit.mask).join(stored);
          maskedStrings.push({ real: hit.real, mask: stored });
        }
        edits.push({ ...str.span, text: value });
      }
    }

    // 3. Comments: delete the span; when the line becomes blank, delete the line.
    if (cfg.stripComments) {
      for (const span of analysis.comments) edits.push(commentEdit(code, span));
    }

    // 4. Splice back-to-front so earlier spans stay valid. Overlaps should be
    //    impossible (distinct AST nodes); drop defensively rather than corrupt.
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let masked = code;
    let lastStart = Infinity;
    for (const e of edits) {
      if (e.end > lastStart) continue;
      masked = masked.slice(0, e.start) + e.text + masked.slice(e.end);
      lastStart = e.start;
    }

    // 5. Verify: the rewrite must still parse cleanly, or we produced garbage —
    //    fail safe (caller falls back to detector-only on the ORIGINAL text).
    const checkTree = parser.parse(masked);
    if (!checkTree || countParseErrors(checkTree.rootNode) > 0) {
      throw new PolyMaskError(`masked ${lang} output failed to re-parse — refusing to emit it`);
    }

    // 6. Hardcoded secrets: detector runs LAST so spans are valid against the
    //    masked text; skip anything already carrying a placeholder.
    const swappedSecrets: MaskResult["swappedSecrets"] = [];
    if (cfg.scrubSecrets) {
      const { findings } = scan(masked, cfg.detectorConfig);
      const fresh = findings.filter((f) => !f.value.includes(MOCK_MARKER));
      if (fresh.length > 0) {
        const swap = buildSwap(masked, fresh, cfg.sessionSalt);
        masked = swap.swappedText;
        for (const m of swap.mappings) {
          session.add("secret", m.real, m.mock);
          swappedSecrets.push({ mock: m.mock });
        }
      }
    }

    return { masked, session, maskedIdentifiers, maskedStrings, maskedModuleSpecifiers, swappedSecrets };
  }

  /** Reverse a masked LLM response — same longest-first, word-boundary logic as the TS masker. */
  rehydrate(text: string, session: SessionMap): string {
    return rehydrate(text, session);
  }
}

/**
 * Deleting just a comment's span leaves a dangling blank line (or trailing
 * whitespace). Expand the edit: a whole-line comment removes the entire line
 * including its newline; a trailing comment removes the whitespace run before
 * it too.
 */
function commentEdit(src: string, span: Span): Edit {
  const lineStart = src.lastIndexOf("\n", span.start - 1) + 1;
  const before = src.slice(lineStart, span.start);
  let end = span.end;
  // (Block comments may span lines; `end` is wherever the comment ends.)
  if (/^\s*$/.test(before)) {
    if (src[end] === "\r") end++;
    if (src[end] === "\n") end++;
    return { start: lineStart, end, text: "" };
  }
  let start = span.start;
  while (start > lineStart && (src[start - 1] === " " || src[start - 1] === "\t")) start--;
  return { start, end, text: "" };
}
