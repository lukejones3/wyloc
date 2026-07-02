import type { Node } from "web-tree-sitter";
import type { MaskKind } from "@wyloc/code-masker";

/** Languages this masker can handle. TS/JS stay in @wyloc/code-masker. */
export type LanguageId =
  | "go" | "java" | "csharp" | "kotlin" | "python" | "cobol" | "rust" | "c" | "cpp";

export const LANGUAGE_IDS: readonly LanguageId[] = [
  "go",
  "java",
  "csharp",
  "kotlin",
  "python",
  "cobol",
  "rust",
  "c",
  "cpp",
] as const;

/** A byte range [start, end) in the source text. */
export interface Span {
  start: number;
  end: number;
}

/**
 * One internal symbol to rename. `spans` is EVERY occurrence the analyzer
 * resolved — the byte-span rewrite renames exactly these, nothing else, so an
 * external identifier that happens to share the name is never touched.
 * `mask` is the analyzer's proposed mask; the engine passes it through the
 * session map, which may suffix it on collision — the STORED value is spliced.
 */
export interface SymbolTarget {
  kind: MaskKind;
  real: string;
  mask: string;
  spans: Span[];
}

/** A string-literal body eligible for the internal-infrastructure pass. */
export interface StringTarget {
  /** Span of the literal's CONTENT (inside the quotes). */
  span: Span;
  text: string;
}

/** Everything one language analyzer resolves from a parsed file. */
export interface LangAnalysis {
  symbols: SymbolTarget[];
  strings: StringTarget[];
  comments: Span[];
}

/** Identifier kinds the analyzers may propose (subset of MaskKind). */
export type IdentifierKind =
  | "class"
  | "function"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "member"
  | "import";

/** What the engine hands each analyzer. */
export interface AnalyzerCtx {
  src: string;
  /** Internal package/module prefixes for THIS language (config + discovery). */
  prefixes: readonly string[];
  /**
   * Extra names known-internal from outside this file (the project symbol
   * index / session accumulation). Closes the same-package / C#-usings gap.
   */
  extraInternalTypes: ReadonlySet<string>;
  /** Deterministic short hash (already salted). */
  hash: (s: string) => string;
  /** Shape an identifier mask with the shared Class_/fn_/… prefixes. */
  maskId: (real: string, kind: IdentifierKind) => string;
}

export type Analyzer = (root: Node, ctx: AnalyzerCtx) => LangAnalysis;

export type { MaskKind };
