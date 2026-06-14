import ts from "typescript";
import type { CodeMaskerConfig } from "./config.js";
import type { MaskKind } from "./types.js";

/**
 * Classification: decide, via AST + the binder's scope/symbol resolution, which
 * identifiers are internally-DEFINED proprietary names (mask) vs external /
 * library / generic-local names (never touch). This is the make-or-break
 * correctness layer — the analog of "leave CTE aliases alone" in the SQL masker.
 *
 * The output is a Map keyed by the canonical Symbol, so every *reference* to a
 * masked declaration (resolved through the checker) renames to the same token
 * and the code stays valid.
 */
export interface MaskedSymbol {
  kind: Extract<MaskKind, "class" | "function" | "interface" | "type" | "enum" | "namespace" | "member" | "import">;
  real: string;
}

type Origin = "relative" | "internal-bare" | "external" | "node";

/** Where does an import's module specifier point? */
export function importOrigin(spec: string, cfg: CodeMaskerConfig): Origin {
  if (spec.startsWith(".")) return "relative";
  if (spec.startsWith("node:")) return "node";
  for (const rule of cfg.internalScopes) {
    if (typeof rule === "string" ? spec === rule || spec.startsWith(rule) : rule.test(spec)) {
      return "internal-bare";
    }
  }
  return "external";
}

/** An import origin we treat as internal-proprietary (defined in the project). */
function isInternalOrigin(o: Origin): boolean {
  return o === "relative" || o === "internal-bare";
}

function sym(checker: ts.TypeChecker, node: ts.Node | undefined): ts.Symbol | undefined {
  return node ? checker.getSymbolAtLocation(node) : undefined;
}

/**
 * Does a class/interface extend or implement anything that is NOT an in-file
 * internal type? If so we conservatively skip masking its members, because a
 * renamed method might be silently overriding / implementing an external
 * signature (e.g. `toString`, a React lifecycle method, a library interface).
 */
function hasExternalHeritage(
  decl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
  internalDeclSymbols: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  const clauses = decl.heritageClauses ?? [];
  for (const clause of clauses) {
    for (const t of clause.types) {
      const s = sym(checker, t.expression);
      if (!s || !internalDeclSymbols.has(s)) return true;
    }
  }
  return false;
}

const MASKABLE_MEMBER_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/**
 * Compute the set of maskable symbols for a source file.
 *
 * Two passes: first collect the top-level declared types/classes (so heritage
 * checks can tell internal-from-external), then collect members + imports.
 */
export function collectMaskedSymbols(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  cfg: CodeMaskerConfig,
): Map<ts.Symbol, MaskedSymbol> {
  const masked = new Map<ts.Symbol, MaskedSymbol>();
  const declSymbols = new Set<ts.Symbol>(); // all internal top-level decl symbols

  const record = (kind: MaskedSymbol["kind"], name: ts.Node | undefined) => {
    const s = sym(checker, name);
    if (!s) return;
    declSymbols.add(s);
    if (!masked.has(s) && name && ts.isIdentifier(name)) {
      masked.set(s, { kind, real: name.text });
    }
  };

  // ── Pass 1: top-level (and nested) declarations ──
  const declare = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name && cfg.maskClasses) {
      record("class", node.name);
    } else if (ts.isFunctionDeclaration(node) && node.name && cfg.maskFunctions) {
      record("function", node.name);
    } else if (ts.isInterfaceDeclaration(node) && cfg.maskTypes) {
      record("interface", node.name);
    } else if (ts.isTypeAliasDeclaration(node) && cfg.maskTypes) {
      record("type", node.name);
    } else if (ts.isEnumDeclaration(node) && cfg.maskEnums) {
      record("enum", node.name);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && cfg.maskNamespaces) {
      record("namespace", node.name);
    }
    ts.forEachChild(node, declare);
  };
  declare(sf);

  // ── Pass 2a: imports (relative or internal-scope) ──
  if (cfg.maskRelativeImports) {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (!isInternalOrigin(importOrigin(stmt.moduleSpecifier.text, cfg))) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) record("import", clause.name); // default import
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        record("import", nb.name);
      } else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) record("import", el.name);
      }
    }
  }

  // ── Pass 2b: members of internal classes / interfaces ──
  if (cfg.maskMembers) {
    const reserved = new Set(cfg.reservedMembers);
    const memberHosts: (ts.ClassLikeDeclaration | ts.InterfaceDeclaration)[] = [];
    const collectHosts = (node: ts.Node) => {
      if (
        (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name &&
        masked.has(checker.getSymbolAtLocation(node.name)!)
      ) {
        memberHosts.push(node);
      }
      ts.forEachChild(node, collectHosts);
    };
    collectHosts(sf);

    for (const host of memberHosts) {
      if (hasExternalHeritage(host, declSymbols, checker)) continue;
      for (const member of host.members) {
        if (!MASKABLE_MEMBER_KINDS.has(member.kind)) continue;
        const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
        if (modifiers?.some((m) => m.kind === ts.SyntaxKind.OverrideKeyword)) continue;
        const name = member.name;
        if (!name || !ts.isIdentifier(name)) continue; // skip computed / string keys
        if (reserved.has(name.text)) continue;
        record("member", name);
      }
    }
  }

  return masked;
}
