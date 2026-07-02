import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { LanguageId } from "./types.js";

/**
 * Lazy, cached grammar loading. One WASM grammar per language, loaded on first
 * use and kept for the life of the process (grammar load is 2–25ms, parse is
 * sub-millisecond; a gateway only pays for the languages wyloc.json enables).
 *
 * VERSION PINS (from the Phase-1 spikes):
 *  - tree-sitter-wasms@0.1.13 grammar builds are ABI-incompatible with
 *    web-tree-sitter 0.26.x — both packages are pinned exactly in
 *    package.json. Bump them together, never separately.
 *  - COBOL comes from @unit-mesh/treesitter-artifacts@1.7.7 (MIT, built from
 *    yutaro-sakamoto/tree-sitter-cobol). It is 9.5MB; V8's OPTIMIZING wasm
 *    compiler (turboshaft, Node ≥23) fatally OOMs tiering it up — the process
 *    must run with --liftoff-only on those Nodes (the gateway CLI re-execs
 *    itself; the packaged SEA binary pins Node 22, which is unaffected).
 *
 * BUNDLED-RUNTIME OVERRIDE: the standalone SEA binary has no node_modules, so
 * the gateway calls setGrammarDir(<install>/runtime/wasm) at startup and both
 * the web-tree-sitter core wasm and every grammar resolve from there instead.
 */

/** Which package a grammar wasm ships in (dev/node_modules resolution). */
const GRAMMAR_SOURCE: Record<LanguageId, { pkg: string; sub: string; file: string }> = {
  go: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-go.wasm" },
  java: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-java.wasm" },
  csharp: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-c_sharp.wasm" },
  kotlin: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-kotlin.wasm" },
  python: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-python.wasm" },
  cobol: { pkg: "@unit-mesh/treesitter-artifacts", sub: "wasm", file: "tree-sitter-COBOL.wasm" },
  rust: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-rust.wasm" },
  c: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-c.wasm" },
  cpp: { pkg: "tree-sitter-wasms", sub: "out", file: "tree-sitter-cpp.wasm" },
};

const require = createRequire(import.meta.url);

/** Bundled-runtime override (SEA binary): grammars + core wasm live here. */
let grammarDirOverride: string | null = null;

export function setGrammarDir(dir: string): void {
  grammarDirOverride = dir;
}

function wasmPath(id: LanguageId): string {
  const src = GRAMMAR_SOURCE[id];
  if (grammarDirOverride) return join(grammarDirOverride, src.file);
  const pkgJson = require.resolve(`${src.pkg}/package.json`);
  return join(dirname(pkgJson), src.sub, src.file);
}

/**
 * A 112-byte wasm side module exporting ASCII toupper/tolower, loaded
 * GLOBALLY at Parser.init so its exports merge into the emscripten runtime's
 * symbol table. The COBOL grammar's external scanner IMPORTS these two libc
 * functions, which web-tree-sitter's core runtime does not provide — without
 * the shim the lazy import stub throws ("resolved is not a function") the
 * first time a parse walks a case-normalization path. Hand-assembled
 * (scratch spike make-shim.mjs), semantics unit-verified; harmless to every
 * other grammar (symbols merge only when not already defined).
 */
const LIBC_SHIM_FILE = "wyloc-libc-shim.wasm";
const LIBC_SHIM_B64 =
  "AGFzbQEAAAAADwhkeWxpbmsuMAEEAAAAAAEGAWABfwF/AwMCAAAHFQIHdG91cHBlcgAAB3RvbG93ZXIAAQoxAhcAIABBIGsgACAAQeEATiAAQfoATHEbCxcAIABBIGogACAAQcEATiAAQdoATHEbCw==";

function writeLibcShim(): string | null {
  try {
    const path = join(tmpdir(), `${LIBC_SHIM_FILE}-${process.pid}`);
    writeFileSync(path, Buffer.from(LIBC_SHIM_B64, "base64"));
    return path;
  } catch {
    return null; // COBOL degrades to detector-only via the PolyMaskError path
  }
}

let initPromise: Promise<unknown> | null = null;
const languageCache = new Map<LanguageId, Promise<Language>>();

async function languageFor(id: LanguageId): Promise<Language> {
  let cached = languageCache.get(id);
  if (!cached) {
    if (!initPromise) {
      const shimPath = writeLibcShim();
      // locateFile serves three lookups: the libc shim (absolute temp path),
      // and — in the bundled binary — the core tree-sitter.wasm + grammars
      // from the runtime dir (there is no package directory to find them in).
      const locateFile = (file: string, prefix: string): string =>
        file === LIBC_SHIM_FILE && shimPath
          ? shimPath
          : grammarDirOverride
            ? join(grammarDirOverride, file)
            : prefix + file;
      initPromise = Parser.init({
        locateFile,
        ...(shimPath ? { dynamicLibraries: [LIBC_SHIM_FILE] } : {}),
      });
    }
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
