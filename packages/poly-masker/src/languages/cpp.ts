import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, spanOf, walk } from "../tree.js";
import { declaratorName } from "./c.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * C++ analyzer — C's preprocessor rules plus namespaces/templates.
 *
 * Classification:
 *  - includes: `<…>` system external; `"…"` local = project (path masked,
 *    header-declared names via the project index, snippet path under-masks)
 *  - namespaces: masked only when the top segment matches
 *    internalPackagePrefixes.cpp ("voltra") — C++ files legitimately reopen
 *    std/external namespaces, so own-namespace is NOT unconditionally
 *    internal (unlike C#/Java)
 *  - declared classes/structs/enums (with bodies), typedefs, using-aliases,
 *    free functions = internal; std:: and anything unresolvable = never
 *
 * CONSERVATISM (the Tier-2 rule):
 *  - full C preprocessor gating: #define names never masked, no renames in
 *    macro definitions or #if/#ifdef conditions
 *  - no template-instantiation reasoning: template parameters are locals,
 *    methods/fields/out-of-class member definitions are members (off)
 *  - qualified references rewrite only when the namespace prefix is provably
 *    internal; everything ambiguous is left alone
 */

const PREPROC_DEF_CONTEXTS = ["preproc_def", "preproc_function_def"];

function inPreprocCondition(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (
      (p.type === "preproc_if" || p.type === "preproc_elif") &&
      p.childForFieldName("condition") &&
      n.startIndex >= p.childForFieldName("condition")!.startIndex &&
      n.endIndex <= p.childForFieldName("condition")!.endIndex
    )
      return true;
    if (p.type === "preproc_ifdef" && p.childForFieldName("name")?.id === n.id) return true;
  }
  return false;
}

function isInternalNamespace(ns: string, prefixes: readonly string[]): boolean {
  const top = ns.split("::")[0]!.trim();
  return prefixes.some((p) => p.length > 0 && top === p.replace(/::.*$/, ""));
}

export function analyzeCpp(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];
  const renameTargets = new Map<string, SymbolTarget>();
  const includePathNodes = new Set<number>();

  // ── 1. #define names: hard never-mask (C rule). ──
  const defined = new Set<string>();
  for (const def of collect(root, PREPROC_DEF_CONTEXTS)) {
    const name = def.childForFieldName("name");
    if (name) defined.add(name.text);
  }

  // ── 2. Includes: local paths masked; system never. ──
  for (const inc of collect(root, ["preproc_include"])) {
    const path = inc.childForFieldName("path");
    if (path?.type === "string_literal") {
      includePathNodes.add(path.id);
      const real = path.text.slice(1, -1);
      const ext = real.match(/\.[a-zA-Z]+$/)?.[0] ?? ".hpp";
      symbols.push({
        kind: "module-specifier",
        real,
        mask: `masked_mod_${ctx.hash(`inc:${real}`)}${ext}`,
        spans: [{ start: path.startIndex + 1, end: path.endIndex - 1 }],
      });
    }
  }

  // ── 3. Internal namespaces (config-gated) + internal using directives. ──
  const nsMask = (ns: string) => `masked_ns_${ctx.hash(`ns:${ns}`)}`;
  for (const ns of collect(root, ["namespace_definition"])) {
    const name = ns.childForFieldName("name");
    if (name && isInternalNamespace(name.text, ctx.prefixes)) {
      symbols.push({ kind: "namespace", real: name.text, mask: nsMask(name.text), spans: [spanOf(name)] });
    }
  }
  for (const u of collect(root, ["using_declaration"])) {
    // `using namespace voltra::x;` / `using voltra::x::Y;` — mask internal paths.
    const q = u.namedChildren.find((c) => c && (c.type === "qualified_identifier" || c.type === "namespace_identifier" || c.type === "identifier"));
    if (q && isInternalNamespace(q.text, ctx.prefixes)) {
      symbols.push({ kind: "module-specifier", real: q.text, mask: nsMask(q.text), spans: [spanOf(q)] });
    }
  }

  const declare = (name: string | undefined | null, kind: IdentifierKind): void => {
    if (!name || renameTargets.has(name) || defined.has(name) || name === "main") return;
    renameTargets.set(name, { kind, real: name, mask: ctx.maskId(name, kind), spans: [] });
  };

  // ── 4. Declarations. Methods / out-of-class member definitions are members
  //       (off): a function_definition whose declarator name is qualified
  //       (Foo::bar) or that sits inside a class body is skipped. ──
  for (const spec of collect(root, ["class_specifier", "struct_specifier"])) {
    if (spec.childForFieldName("body")) declare(spec.childForFieldName("name")?.text, "class");
  }
  for (const spec of collect(root, ["enum_specifier"])) {
    if (spec.childForFieldName("body")) declare(spec.childForFieldName("name")?.text, "enum");
  }
  for (const td of collect(root, ["type_definition"])) {
    declare(declaratorName(td.childForFieldName("declarator"))?.text, "type");
  }
  for (const alias of collect(root, ["alias_declaration"])) {
    declare(alias.childForFieldName("name")?.text, "type");
  }
  for (const fn of collect(root, ["function_definition"])) {
    if (hasAncestor(fn, ["class_specifier", "struct_specifier"])) continue; // methods — off
    // Out-of-class member definition (void Foo::bar() {…}) — member, off.
    // Only the NAME chain matters: qualified_identifiers in PARAMETER types
    // (std::vector<…>) must not disqualify a free function.
    let d = fn.childForFieldName("declarator");
    let memberDef = false;
    while (d) {
      if (d.type === "qualified_identifier") { memberDef = true; break; }
      if (d.type === "identifier" || d.type === "type_identifier" || d.type === "field_identifier") break;
      d = d.childForFieldName("declarator") ?? null;
    }
    if (memberDef) continue;
    declare(declaratorName(fn.childForFieldName("declarator"))?.text, "function");
  }

  // ── 4b. Local-header names from the project index. ──
  for (const name of ctx.extraInternalTypes) {
    if (!defined.has(name)) declare(name, "import");
  }

  // ── 5. Fully-qualified internal references (voltra::ledger::X) — single
  //       edit per top-level qualified_identifier, longest match only. ──
  walk(root, (n) => {
    if (n.type !== "qualified_identifier") return;
    if (n.parent?.type === "qualified_identifier") return;
    // Skip using-declaration paths and the namespace's NAME (they have their
    // own edits) — the namespace BODY holds the whole file and must be walked.
    if (hasAncestor(n, ["using_declaration", ...PREPROC_DEF_CONTEXTS])) return;
    if (
      (n.parent?.type === "namespace_definition") &&
      n.parent.childForFieldName("name")?.id === n.id
    )
      return;
    const text = n.text;
    const lastSep = text.lastIndexOf("::");
    if (lastSep <= 0) return;
    const nsPart = text.slice(0, lastSep);
    const finalName = text.slice(lastSep + 2);
    if (!isInternalNamespace(nsPart, ctx.prefixes)) return;
    const finalMask = renameTargets.get(finalName)?.mask ?? ctx.maskId(`${nsPart}::${finalName}`, "import");
    symbols.push({
      kind: "import",
      real: text,
      mask: `${nsMask(nsPart)}::${finalMask}`,
      spans: [spanOf(n)],
    });
  });

  // ── 6. Every resolved occurrence of a rename target. namespace_identifier
  //       is included because the CLASS side of `Foo::method` (out-of-class
  //       member definitions, static calls) parses as one. ──
  walk(root, (n) => {
    if (n.type !== "identifier" && n.type !== "type_identifier" && n.type !== "namespace_identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, PREPROC_DEF_CONTEXTS)) return;
    if (hasAncestor(n, ["preproc_include"])) return;
    if (inPreprocCondition(n)) return;
    // inside an internal fully-qualified reference the step-5 edit covers it
    if (n.parent?.type === "qualified_identifier") {
      let top = n.parent;
      while (top.parent?.type === "qualified_identifier") top = top.parent;
      const lastSep = top.text.lastIndexOf("::");
      if (lastSep > 0 && isInternalNamespace(top.text.slice(0, lastSep), ctx.prefixes)) return;
    }
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 7. Strings (incl. raw R"(…)" and #define values) + comments. ──
  walk(root, (n) => {
    if (n.type === "string_literal" && !includePathNodes.has(n.id)) {
      const span = { start: n.startIndex + 1, end: n.endIndex - 1 };
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    } else if (n.type === "raw_string_literal") {
      const open = n.text.match(/^R"([^(]*)\(/);
      if (open) {
        const lead = 2 + open[1]!.length + 1;
        const trail = open[1]!.length + 2;
        const span = { start: n.startIndex + lead, end: n.endIndex - trail };
        if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
      }
    } else if (n.type === "preproc_arg") {
      for (const match of n.text.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
        const start = n.startIndex + (match.index ?? 0) + 1;
        const end = start + match[0].length - 2;
        if (end > start) strings.push({ span: { start, end }, text: ctx.src.slice(start, end) });
      }
    }
    if (n.type === "comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
