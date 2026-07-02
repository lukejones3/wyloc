import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, innerSpan, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * Java analyzer.
 *
 * Classification signal: the package/import system. An import whose FQN
 * starts with a configured internal prefix ("com.acme.") is INTERNAL —
 * java.* / javax.* / third-party FQNs never match and are never touched. The
 * file's OWN package declaration and top-level type declarations are internal
 * by definition (they ARE the company's code being sent).
 *
 * What gets masked:
 *  - the package declaration's dotted name                     → masked.mod_<h>
 *  - internal import FQNs (rewritten to masked.mod_<h>.Import_<h>)
 *  - the simple names those imports bind, at every resolved reference
 *  - declared classes / interfaces / enums / records / annotations
 *    (top-level and nested), at every resolved reference
 * What is deliberately NOT masked:
 *  - methods and fields (member masking off — a name-based member rename can
 *    collide with an external member of the same name)
 *  - anything reached via an EXTERNAL import, java.lang implicits (String,
 *    RuntimeException…), locals/params — the make-or-break rule
 *  - names bound by an internal WILDCARD import (`import com.acme.util.*`):
 *    unenumerable syntactically → conservative under-mask (the project
 *    symbol index closes this, same as same-package references)
 *
 * Same-package references (used with no import at all) are not resolvable
 * from this file alone; the project symbol index / session accumulation
 * supplies them via ctx.extraInternalTypes.
 */

const DECL_TYPES: Record<string, IdentifierKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "class",
  annotation_type_declaration: "interface",
};

/** Contexts where a matching name is a MEMBER access, never a type/import ref. */
function isMemberPosition(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (p.type === "field_access" && p.childForFieldName("field")?.id === n.id) return true;
  if (p.type === "method_invocation" && p.childForFieldName("name")?.id === n.id) return true;
  if (p.type === "method_declaration" && p.childForFieldName("name")?.id === n.id) return true;
  // `Type::method` — the method side of a method reference is a member.
  if (p.type === "method_reference" && p.child(p.childCount - 1)?.id === n.id) return true;
  return false;
}

export function analyzeJava(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];

  // ── 1. Own package declaration: internal identity, always masked. ──
  for (const pkg of collect(root, ["package_declaration"])) {
    const name = pkg.namedChildren.find(
      (c) => c && (c.type === "scoped_identifier" || c.type === "identifier"),
    );
    if (name) {
      symbols.push({
        kind: "namespace",
        real: name.text,
        mask: `masked.mod_${ctx.hash(`pkg:${name.text}`)}`,
        spans: [spanOf(name)],
      });
    }
  }

  // ── 2. Imports: classify by FQN prefix; mask internal FQN + bound name. ──
  // renameTargets: simple name -> its (shared) symbol entry, filled from refs.
  const renameTargets = new Map<string, SymbolTarget>();
  for (const imp of collect(root, ["import_declaration"])) {
    const fqnNode = imp.namedChildren.find(
      (c) => c && (c.type === "scoped_identifier" || c.type === "identifier"),
    );
    if (!fqnNode) continue;
    const fqn = fqnNode.text;
    const isWildcard = imp.text.includes(".*") || imp.namedChildren.some((c) => c?.type === "asterisk");
    if (!ctx.prefixes.some((p) => p.length > 0 && fqn.startsWith(p))) continue; // external — never touch
    if (isWildcard) continue; // unenumerable — conservative under-mask (see docs)

    const simple = fqn.slice(fqn.lastIndexOf(".") + 1);
    const packagePart = fqn.slice(0, Math.max(0, fqn.lastIndexOf(".")));
    const boundMask = ctx.maskId(fqn, "import");
    // Rewrite the whole FQN inside the import statement in one edit.
    symbols.push({
      kind: "module-specifier",
      real: fqn,
      mask: `masked.mod_${ctx.hash(`pkg:${packagePart}`)}.${boundMask}`,
      spans: [spanOf(fqnNode)],
    });
    if (!renameTargets.has(simple)) {
      renameTargets.set(simple, { kind: "import", real: simple, mask: boundMask, spans: [] });
    }
  }

  // ── 3. Declared types (top-level and nested). ──
  for (const [declType, kind] of Object.entries(DECL_TYPES)) {
    for (const decl of collect(root, [declType])) {
      const name = decl.childForFieldName("name");
      if (!name || renameTargets.has(name.text)) continue;
      renameTargets.set(name.text, {
        kind,
        real: name.text,
        mask: ctx.maskId(name.text, kind),
        spans: [],
      });
    }
  }

  // ── 3b. Names known-internal from outside this file (project index). ──
  for (const name of ctx.extraInternalTypes) {
    if (!renameTargets.has(name)) {
      renameTargets.set(name, { kind: "import", real: name, mask: ctx.maskId(name, "import"), spans: [] });
    }
  }

  // ── 4. Every resolved occurrence of a rename target. ──
  walk(root, (n) => {
    if (n.type !== "identifier" && n.type !== "type_identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    // Inside package/import declarations the FQN edit already covers the text.
    if (hasAncestor(n, ["package_declaration", "import_declaration"])) return;
    if (isMemberPosition(n)) return;
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 5. String literals + comments. ──
  walk(root, (n) => {
    if (n.type === "string_literal") {
      const quoteLen = n.text.startsWith('"""') ? 3 : 1; // text block vs plain
      const span = innerSpan(n, quoteLen);
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    }
    if (n.type === "line_comment" || n.type === "block_comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
