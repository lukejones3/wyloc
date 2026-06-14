import ts from "typescript";

/**
 * Build a single-file Program over an in-memory source string.
 *
 * We deliberately do NOT resolve external modules. Classification reads import
 * declarations *structurally* (the module specifier text on the AST) and uses
 * the binder's in-file scope/symbol resolution — neither of which needs
 * node_modules. This keeps masking offline, fast, and side-effect free, and it
 * sidesteps the Phase-1 finding that symlinked workspace packages resolve back
 * into in-repo source (which would mislabel them as "internal").
 *
 * The TypeChecker we return gives stable symbol identity, so every reference to
 * an internal declaration resolves to the same Symbol and renames consistently.
 */
export interface ParsedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  scriptKind: ts.ScriptKind;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.jsx?$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parse(code: string, fileName = "input.ts"): ParsedProgram {
  const scriptKind = scriptKindFor(fileName);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noResolve: true, // do not try to load imported modules from disk
    noLib: false,
    skipLibCheck: true,
    isolatedModules: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    scriptKind,
  );

  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? code : undefined),
  };

  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  // Re-fetch from the program so the checker and our reference agree on identity.
  const sf = program.getSourceFile(fileName) ?? sourceFile;
  return { program, checker, sourceFile: sf, scriptKind };
}
