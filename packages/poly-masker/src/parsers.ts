import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { LanguageId } from "./types.js";

/**
 * Lazy, cached grammar loading. One WASM grammar per language, loaded on first
 * use and kept for the life of the process (grammar load is 2–25ms, parse is
 * sub-millisecond; a gateway only pays for the languages wyloc.json enables).
 *
 * VERSION PIN (from the Phase 1 spike): tree-sitter-wasms@0.1.13 grammar
 * builds are ABI-incompatible with web-tree-sitter 0.26.x — both packages are
 * pinned exactly in package.json. Bump them together, never separately.
 */

const GRAMMAR_FILE: Record<LanguageId, string> = {
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  python: "tree-sitter-python.wasm",
};

const require = createRequire(import.meta.url);

function wasmPath(id: LanguageId): string {
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgJson), "out", GRAMMAR_FILE[id]);
}

let initPromise: Promise<unknown> | null = null;
const languageCache = new Map<LanguageId, Promise<Language>>();

async function languageFor(id: LanguageId): Promise<Language> {
  let cached = languageCache.get(id);
  if (!cached) {
    initPromise ??= Parser.init();
    cached = initPromise.then(() => Language.load(wasmPath(id)));
    languageCache.set(id, cached);
  }
  return cached;
}

/** A fresh parser bound to the (cached) grammar for `id`. */
export async function parserFor(id: LanguageId): Promise<Parser> {
  const language = await languageFor(id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
