import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, innerSpan, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * C# analyzer — the language where import-based classification alone is NOT
 * sufficient (the make-or-break Phase 1 finding): a `using Voltra.Ledger;`
 * imports a NAMESPACE, not names, so a bare `LedgerClient` reference is
 * syntactically indistinguishable from an external type like `HttpClient`.
 *
 * The classification therefore has TWO internal sources:
 *   1. Declared in the visible content (types, incl. nested) — always known.
 *   2. ctx.extraInternalTypes — the project symbol index (sibling-file scan on
 *      the file-read path). On the pasted-snippet path, where no index exists,
 *      names imported from other files are deliberately LEFT ALONE: the
 *      failure mode is a safe under-mask, never a broken external identifier.
 *
 * What gets masked:
 *  - the file's own namespace declaration(s)                    → masked.mod_<h>
 *  - internal `using` paths (they reveal architecture)          → masked.mod_<h>
 *  - fully-qualified references to internal namespaces in code
 *  - declared types + index-resolved types, at every resolved reference
 * What is deliberately NOT masked:
 *  - System.* / NuGet types, ASP.NET attributes, LINQ methods — anything not
 *    provably internal (the make-or-break rule)
 *  - members: methods/properties/fields (member masking off)
 */

const DECL_KINDS: Record<string, IdentifierKind> = {
  class_declaration: "class",
  record_declaration: "class",
  struct_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  delegate_declaration: "type",
};

function isInternalNamespace(ns: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => p.length > 0 && (ns === p.replace(/\.$/, "") || ns.startsWith(p) || `${ns}.`.startsWith(p)),
  );
}

/** Contexts where a matching identifier is a MEMBER, never a type reference. */
function isMemberPosition(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (p.type === "member_access_expression" && p.childForFieldName("name")?.id === n.id) return true;
  if (p.type === "member_binding_expression") return true; // ?.Name
  // Declaration name positions for members (a method/property may coincide
  // with a type name; renaming the member would change the public shape).
  if (
    (p.type === "method_declaration" || p.type === "property_declaration" ||
      p.type === "event_declaration" || p.type === "enum_member_declaration") &&
    p.childForFieldName("name")?.id === n.id
  )
    return true;
  return false;
}

export function analyzeCSharp(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];

  // ── 1. Own namespace declarations: internal identity, always masked. ──
  for (const ns of collect(root, ["namespace_declaration", "file_scoped_namespace_declaration"])) {
    const name = ns.childForFieldName("name");
    if (name) {
      symbols.push({
        kind: "namespace",
        real: name.text,
        mask: `masked.mod_${ctx.hash(`ns:${name.text}`)}`,
        spans: [spanOf(name)],
      });
    }
  }

  // ── 2. Using directives: mask INTERNAL namespace paths; external untouched.
  // (Usings bind no names — bare-name resolution comes from declarations and
  // the project index below.)
  for (const u of collect(root, ["using_directive"])) {
    // Alias form (`using L = Voltra.Ledger;`): mask only the right-hand path.
    const pathNode =
      u.childForFieldName("name") ??
      [...u.namedChildren].reverse().find((c) => c && (c.type === "qualified_name" || c.type === "identifier"));
    if (!pathNode) continue;
    const ns = pathNode.text;
    if (!isInternalNamespace(ns, ctx.prefixes)) continue;
    symbols.push({
      kind: "module-specifier",
      real: ns,
      mask: `masked.mod_${ctx.hash(`ns:${ns}`)}`,
      spans: [spanOf(pathNode)],
    });
  }

  // ── 3. Rename targets: declared types (incl. nested) + index-resolved. ──
  const renameTargets = new Map<string, SymbolTarget>();
  for (const [declType, kind] of Object.entries(DECL_KINDS)) {
    for (const decl of collect(root, [declType])) {
      const name = decl.childForFieldName("name");
      if (!name || renameTargets.has(name.text)) continue;
      renameTargets.set(name.text, { kind, real: name.text, mask: ctx.maskId(name.text, kind), spans: [] });
    }
  }
  for (const name of ctx.extraInternalTypes) {
    if (!renameTargets.has(name)) {
      renameTargets.set(name, { kind: "import", real: name, mask: ctx.maskId(name, "import"), spans: [] });
    }
  }

  // ── 4. Fully-qualified internal references in code (Voltra.Ledger.X). ──
  // Longest match only: skip a qualified_name whose parent qualified_name
  // already matched. The whole path collapses to one module token + the type.
  walk(root, (n) => {
    if (n.type !== "qualified_name") return;
    if (n.parent?.type === "qualified_name") return; // longest match only
    // Skip the PATH of a using directive and the NAME of a namespace
    // declaration — those spans have their own edits (steps 1–2). The
    // namespace BODY (everything else in the file) must still be walked.
    if (hasAncestor(n, ["using_directive"])) return;
    const p = n.parent;
    if (
      (p?.type === "namespace_declaration" || p?.type === "file_scoped_namespace_declaration") &&
      p.childForFieldName("name")?.id === n.id
    )
      return;
    const text = n.text;
    // Split "Voltra.Ledger.LedgerClient" into namespace part + final name.
    const lastDot = text.lastIndexOf(".");
    if (lastDot < 0) return;
    const nsPart = text.slice(0, lastDot);
    const finalName = text.slice(lastDot + 1);
    if (!isInternalNamespace(nsPart, ctx.prefixes)) return;
    // Keep the type's mask CONSISTENT with bare references to the same name:
    // a known rename target contributes its own mask as the final segment.
    const finalMask = renameTargets.get(finalName)?.mask ?? ctx.maskId(`${nsPart}.${finalName}`, "import");
    symbols.push({
      kind: "import",
      real: text,
      mask: `masked.mod_${ctx.hash(`ns:${nsPart}`)}.${finalMask}`,
      spans: [spanOf(n)],
    });
  });

  // ── 5. Every resolved occurrence of a rename target. ──
  walk(root, (n) => {
    if (n.type !== "identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, ["using_directive"])) return; // the using-path edit covers it
    if (isMemberPosition(n)) return;
    // Skip identifiers inside a span another edit already rewrites: a
    // namespace declaration's dotted name (step 1) or a fully-qualified
    // internal reference (step 4).
    if (n.parent?.type === "qualified_name") {
      let top = n.parent;
      while (top.parent?.type === "qualified_name") top = top.parent;
      const isNamespaceName =
        top.parent?.type === "namespace_declaration" ||
        top.parent?.type === "file_scoped_namespace_declaration";
      if (isNamespaceName) return;
      const lastDot = top.text.lastIndexOf(".");
      if (lastDot > 0 && isInternalNamespace(top.text.slice(0, lastDot), ctx.prefixes)) return;
    }
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 6. String literals + comments. ──
  walk(root, (n) => {
    if (n.type === "string_literal") {
      const span = innerSpan(n, 1);
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    } else if (n.type === "verbatim_string_literal") {
      // @"..." — strip the @ and quotes.
      const span = { start: n.startIndex + 2, end: n.endIndex - 1 };
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    } else if (n.type === "raw_string_literal") {
      const span = innerSpan(n, 3);
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    } else if (n.type === "interpolated_string_text" || n.type === "string_content") {
      strings.push({ span: spanOf(n), text: n.text });
    }
    if (n.type === "comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
