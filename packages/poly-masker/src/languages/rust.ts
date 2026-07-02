import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * Rust analyzer.
 *
 * Classification signal: use paths + module structure. `crate::` / `self::` /
 * `super::` are internal by construction; a bare top segment is internal only
 * when it matches internalPackagePrefixes.rust (workspace crate names, from
 * Cargo.toml discovery or config); std/core/alloc and external crates never
 * match and are never touched. Declared items (structs/enums/fns/traits/
 * types/mods/macros) are internal by definition.
 *
 * MACRO CONSERVATISM (the Tier-2 rule): tree-sitter does not expand macros,
 * so anything whose identity a macro obscures is LEFT ALONE:
 *  - no renames inside token_tree (macro invocation arguments), inside
 *    macro_definition bodies, or inside attribute_item (#[derive(...)] etc.)
 *  - a locally-declared macro's OWN name is clearly internal — the
 *    macro_rules! name and the `name!` at invocation sites are renamed;
 *    nothing inside the bang's argument list is
 *  - impl/trait functions are members (off); enum variants are members (off)
 * Lower coverage on macro-heavy code is the intended safe failure.
 */

const DECL_KINDS: Record<string, IdentifierKind> = {
  struct_item: "class",
  enum_item: "enum",
  union_item: "class",
  trait_item: "interface",
  type_item: "type",
  mod_item: "namespace",
};

/** Ancestors inside which identity is macro/attribute-obscured — never rename. */
const MACRO_CONTEXTS = ["token_tree", "macro_definition", "attribute_item", "inner_attribute_item"];

function topSegment(path: string): string {
  return path.split("::")[0]!.trim();
}

function isInternalPath(path: string, prefixes: readonly string[]): boolean {
  const top = topSegment(path);
  if (top === "crate" || top === "self" || top === "super") return true;
  return prefixes.some((p) => p.length > 0 && top === p);
}

export function analyzeRust(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];
  const renameTargets = new Map<string, SymbolTarget>();
  /** Macro names declared here — renamed at definition AND `name!` call sites. */
  const macroTargets = new Map<string, SymbolTarget>();

  // ── 1. use declarations: classify by path; mask internal paths + bindings. ──
  for (const useDecl of collect(root, ["use_declaration"])) {
    const arg = useDecl.childForFieldName("argument");
    if (!arg) continue;
    const pathText = arg.text;
    if (!isInternalPath(pathText, ctx.prefixes)) continue; // std/external — never touch
    if (pathText.includes("*")) continue; // wildcard — unenumerable, skip whole use

    const bind = (nameNode: Node, fqnHint: string): void => {
      const bound = nameNode.text;
      if (renameTargets.has(bound)) {
        renameTargets.get(bound)!.spans.push(spanOf(nameNode));
        return;
      }
      renameTargets.set(bound, {
        kind: "import",
        real: bound,
        mask: ctx.maskId(fqnHint, "import"),
        // the name inside the use statement is renamed here; refs in step 4
        spans: [spanOf(nameNode)],
      });
    };

    if (arg.type === "scoped_identifier") {
      // use crate::ledger::LedgerClient;  → rewrite the path prefix, bind leaf
      const name = arg.childForFieldName("name");
      const path = arg.childForFieldName("path");
      if (path && isInternalPath(path.text, ctx.prefixes) && path.text !== "crate") {
        symbols.push({
          kind: "module-specifier",
          real: path.text,
          mask: `crate::mod_${ctx.hash(`use:${path.text}`)}`,
          spans: [spanOf(path)],
        });
      }
      if (name) bind(name, pathText);
    } else if (arg.type === "use_as_clause") {
      // use crate::x::Y as Z; — the alias binds; rewrite the path side whole
      const alias = arg.childForFieldName("alias");
      const original = arg.childForFieldName("path");
      if (original) {
        symbols.push({
          kind: "module-specifier",
          real: original.text,
          mask: `crate::mod_${ctx.hash(`use:${original.text}`)}`,
          spans: [spanOf(original)],
        });
      }
      if (alias) bind(alias, pathText);
    } else if (arg.type === "scoped_use_list") {
      // use crate::fx::{A, B as C}; — rewrite prefix, bind each list entry
      const path = arg.childForFieldName("path");
      if (path && path.text !== "crate") {
        symbols.push({
          kind: "module-specifier",
          real: path.text,
          mask: `crate::mod_${ctx.hash(`use:${path.text}`)}`,
          spans: [spanOf(path)],
        });
      }
      const list = arg.childForFieldName("list");
      for (const entry of list?.namedChildren ?? []) {
        if (!entry) continue;
        if (entry.type === "identifier" || entry.type === "type_identifier") {
          bind(entry, `${path?.text ?? "crate"}::${entry.text}`);
        } else if (entry.type === "use_as_clause") {
          const alias = entry.childForFieldName("alias");
          if (alias) bind(alias, `${path?.text ?? "crate"}::${entry.text}`);
        }
      }
    } else if (arg.type === "identifier") {
      // use some_workspace_crate;  (bare internal crate) — bind the crate name
      bind(arg, pathText);
    }
  }

  // ── 2. Declared items. impl/trait bodies are member scope (off); items
  //       nested in plain `mod` blocks are still internal declarations. ──
  for (const [declType, kind] of Object.entries(DECL_KINDS)) {
    for (const decl of collect(root, [declType])) {
      const name = decl.childForFieldName("name");
      if (!name || renameTargets.has(name.text)) continue;
      renameTargets.set(name.text, { kind, real: name.text, mask: ctx.maskId(name.text, kind), spans: [] });
    }
  }
  for (const fn of collect(root, ["function_item"])) {
    if (hasAncestor(fn, ["impl_item", "trait_item"])) continue; // methods — off
    const name = fn.childForFieldName("name");
    if (!name || name.text === "main" || renameTargets.has(name.text)) continue;
    renameTargets.set(name.text, { kind: "function", real: name.text, mask: ctx.maskId(name.text, "function"), spans: [] });
  }
  for (const macro of collect(root, ["macro_definition"])) {
    const name = macro.childForFieldName("name");
    if (!name || macroTargets.has(name.text)) continue;
    macroTargets.set(name.text, {
      kind: "function",
      real: name.text,
      mask: `fn_${ctx.hash(`macro:${name.text}`)}`,
      spans: [spanOf(name)],
    });
  }

  // ── 2b. Index-resolved names. ──
  for (const name of ctx.extraInternalTypes) {
    if (!renameTargets.has(name)) {
      renameTargets.set(name, { kind: "import", real: name, mask: ctx.maskId(name, "import"), spans: [] });
    }
  }

  // ── 3. Macro invocation sites: rename ONLY the macro's own name;
  //       everything inside the bang's token_tree stays untouched. ──
  walk(root, (n) => {
    if (n.type !== "macro_invocation") return;
    const macroName = n.childForFieldName("macro");
    if (macroName?.type === "identifier") {
      const target = macroTargets.get(macroName.text);
      if (target) target.spans.push(spanOf(macroName));
    }
  });

  // ── 4. Every resolved occurrence of a rename target. ──
  walk(root, (n) => {
    if (n.type !== "identifier" && n.type !== "type_identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, ["use_declaration"])) return; // use edits cover it
    if (hasAncestor(n, MACRO_CONTEXTS)) return; // macro conservatism
    // `x.field` — the field side of a field access is a member.
    const p = n.parent;
    if (p?.type === "field_expression" && p.childForFieldName("field")?.id === n.id) return;
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values(), ...macroTargets.values());

  // ── 5. Strings + comments. This grammar build's string literals are LEAF
  //       nodes including quotes (no string_content children) — compute the
  //       inner span manually. A proprietary host in ANY literal (even inside
  //       a macro token tree) is content: substring masking there is safe. ──
  walk(root, (n) => {
    if (n.type === "string_literal") {
      const span = { start: n.startIndex + 1, end: n.endIndex - 1 };
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    } else if (n.type === "raw_string_literal") {
      // r"…" / r#"…"# / r##"…"## — strip r, hashes, and quotes symmetrically.
      const open = n.text.match(/^r(#*)"/);
      if (open) {
        const lead = 1 + open[1]!.length + 1;
        const span = { start: n.startIndex + lead, end: n.endIndex - (open[1]!.length + 1) };
        if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
      }
    }
    if (n.type === "line_comment" || n.type === "block_comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
