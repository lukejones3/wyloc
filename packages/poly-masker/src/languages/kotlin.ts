import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * Kotlin analyzer.
 *
 * Classification mirrors Java: explicit per-name imports classified by FQN
 * prefix ("com.acme."); kotlin.* / java.* / third-party FQNs and the default
 * imports (kotlin.collections.* etc.) never match and are never touched. The
 * file's own package and declared types are internal by definition.
 * Same-package references come from the project index (ctx.extraInternalTypes).
 *
 * GRAMMAR QUIRKS (fwcd tree-sitter-kotlin, confirmed in the Phase-1 spike and
 * re-verified against the pinned build):
 *  - import_header has NO name field and its node text can SWALLOW a trailing
 *    comment — never regex the header text for spans; use the dotted
 *    `identifier` CHILD node, whose span is exact.
 *  - class_declaration / object_declaration / type_alias have no name field:
 *    the name is the first direct type_identifier child. function_declaration:
 *    first direct simple_identifier child. property_declaration: the
 *    simple_identifier inside its variable_declaration.
 *  - string literals expose string_content children — masking those spans
 *    directly leaves `${…}` interpolations structurally untouched.
 *
 * What gets masked: own package, internal import paths (+ `as` aliases),
 * names bound by internal imports, declared classes/objects/interfaces/
 * enums/typealiases + TOP-LEVEL functions, and index-resolved names — at
 * every resolved reference. NOT masked: members (navigation_suffix / the
 * member side of callable_reference), class-body functions, properties,
 * anything external, internal WILDCARD imports (unenumerable → skip).
 */

/** class_declaration covers class/interface/enum — pick the kind from shape. */
function classKind(decl: Node): IdentifierKind {
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (c?.type === "interface") return "interface";
    if (c?.type === "enum_class_body") return "enum";
  }
  return "class";
}

function firstChildOfType(node: Node, types: readonly string[]): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

/** Member positions: navigation suffixes and the member side of `X::member`. */
function isMemberPosition(n: Node): boolean {
  if (hasAncestor(n, ["navigation_suffix"])) return true;
  const p = n.parent;
  if (p?.type === "callable_reference" && n.type === "simple_identifier") return true;
  return false;
}

export function analyzeKotlin(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];

  // ── 1. Own package: internal identity, always masked. ──
  for (const pkg of collect(root, ["package_header"])) {
    const name = firstChildOfType(pkg, ["identifier"]);
    if (name) {
      symbols.push({
        kind: "namespace",
        real: name.text,
        mask: `masked.mod_${ctx.hash(`pkg:${name.text}`)}`,
        spans: [spanOf(name)],
      });
    }
  }

  // ── 2. Imports: classify by FQN prefix (exact child span — see quirks). ──
  const renameTargets = new Map<string, SymbolTarget>();
  for (const imp of collect(root, ["import_header"])) {
    const pathNode = firstChildOfType(imp, ["identifier"]);
    if (!pathNode) continue;
    const fqn = pathNode.text;
    if (!ctx.prefixes.some((p) => p.length > 0 && fqn.startsWith(p))) continue; // external
    // `import com.acme.util.*` — the wildcard is a sibling token, not part of
    // the identifier child; unenumerable → whole-import conservative skip.
    if (/\.\*\s*$/.test(imp.text) || imp.text.includes(".* ")) continue;

    const aliasNode = collect(imp, ["import_alias"])[0];
    const aliasName = aliasNode ? firstChildOfType(aliasNode, ["type_identifier", "simple_identifier"]) : null;
    const simple = aliasName?.text ?? fqn.slice(fqn.lastIndexOf(".") + 1);
    const packagePart = fqn.slice(0, Math.max(0, fqn.lastIndexOf(".")));
    const boundMask = ctx.maskId(fqn, "import");

    symbols.push({
      kind: "module-specifier",
      real: fqn,
      mask: `masked.mod_${ctx.hash(`pkg:${packagePart}`)}.${boundMask}`,
      spans: [spanOf(pathNode)],
    });
    if (!renameTargets.has(simple)) {
      renameTargets.set(simple, {
        kind: "import",
        real: simple,
        mask: boundMask,
        // An alias binding is renamed at its declaration too (`as Fx`).
        spans: aliasName ? [spanOf(aliasName)] : [],
      });
    }
  }

  // ── 3. Declared types + top-level functions (quirk: no name fields). ──
  for (const decl of collect(root, ["class_declaration"])) {
    const name = firstChildOfType(decl, ["type_identifier"]);
    if (!name || renameTargets.has(name.text)) continue;
    const kind = classKind(decl);
    renameTargets.set(name.text, { kind, real: name.text, mask: ctx.maskId(name.text, kind), spans: [] });
  }
  for (const decl of collect(root, ["object_declaration", "type_alias"])) {
    const name = firstChildOfType(decl, ["type_identifier"]);
    if (!name || renameTargets.has(name.text)) continue;
    const kind: IdentifierKind = decl.type === "type_alias" ? "type" : "class";
    renameTargets.set(name.text, { kind, real: name.text, mask: ctx.maskId(name.text, kind), spans: [] });
  }
  for (const fn of collect(root, ["function_declaration"])) {
    if (hasAncestor(fn, ["class_body", "enum_class_body"])) continue; // methods = members, off
    const name = firstChildOfType(fn, ["simple_identifier"]);
    if (!name || name.text === "main" || renameTargets.has(name.text)) continue;
    renameTargets.set(name.text, { kind: "function", real: name.text, mask: ctx.maskId(name.text, "function"), spans: [] });
  }

  // ── 3b. Index-resolved names (same-package / wildcard gap). ──
  for (const name of ctx.extraInternalTypes) {
    if (!renameTargets.has(name)) {
      renameTargets.set(name, { kind: "import", real: name, mask: ctx.maskId(name, "import"), spans: [] });
    }
  }

  // ── 4. Every resolved occurrence. ──
  walk(root, (n) => {
    if (n.type !== "simple_identifier" && n.type !== "type_identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, ["package_header", "import_header"])) return; // covered by path edits
    if (isMemberPosition(n)) return;
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 5. String content + comments. ──
  walk(root, (n) => {
    // string_content spans exclude quotes AND ${…} interpolations by construction.
    if (n.type === "string_content") {
      strings.push({ span: spanOf(n), text: n.text });
    }
    if (n.type === "line_comment" || n.type === "multiline_comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
