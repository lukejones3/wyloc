import type { Node } from "web-tree-sitter";
import { collect, innerSpan, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * Go analyzer.
 *
 * Classification signal (the importOrigin() analog): the import path. A path
 * equal to / under a configured internal module path (from wyloc.json or
 * go.mod auto-discovery) is INTERNAL; stdlib ("fmt", "net/http") and external
 * modules ("github.com/gin-gonic/gin") never match and are never touched.
 *
 * Go is the cleanest of the five because every cross-package reference is
 * QUALIFIED (`ledger.Client`) — so external identifiers can be left alone by
 * construction, and internal ones are resolvable from the import table alone.
 *
 * What gets masked:
 *  - the file's own package name (`package billing`)               → Mod_/mod_
 *  - internal import paths (they reveal org + architecture)        → masked/mod_<h>
 *  - the package qualifier bound by an internal import + every
 *    qualified selector on it (`ledger.Client`, `fxrates.Provider`)
 *  - internally-DECLARED type/struct/interface names and top-level
 *    functions, renamed at every resolved occurrence
 * What is deliberately NOT masked:
 *  - methods and struct fields (member masking is off — a name-based member
 *    rename can collide with an external member of the same name)
 *  - locals/params (generic names, no proprietary identity — TS-masker parity)
 *  - anything imported from a non-internal path (the make-or-break rule)
 */

/** Kind for a type_spec by its underlying type node. */
function typeSpecKind(spec: Node): IdentifierKind {
  const t = spec.childForFieldName("type")?.type;
  if (t === "struct_type") return "class";
  if (t === "interface_type") return "interface";
  return "type";
}

function isInternalPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => p.length > 0 && (path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)),
  );
}

/**
 * Names that could SHADOW a package qualifier: params, receivers, var/const
 * names, := bindings, range/loop variables. If an internal import's qualifier
 * appears here we skip that import entirely (masking the path while a shadowed
 * qualifier keeps its old name would desynchronize path and references).
 */
function localBindingNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const n of collect(root, ["parameter_declaration", "var_spec", "const_spec", "receive_statement"])) {
    for (const id of collect(n, ["identifier"])) names.add(id.text);
  }
  for (const n of collect(root, ["short_var_declaration", "range_clause"])) {
    const left = n.childForFieldName("left");
    if (left) for (const id of collect(left, ["identifier"])) names.add(id.text);
  }
  return names;
}

export function analyzeGo(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];
  const importPathNodes = new Set<number>();
  const locals = localBindingNames(root);

  // ── 1. The file's own package name (internal by definition). ──
  for (const clause of collect(root, ["package_clause"])) {
    const name = collect(clause, ["package_identifier"])[0];
    // `package main` is a language-mandated name, not proprietary identity.
    if (name && name.text !== "main") {
      symbols.push({
        kind: "namespace",
        real: name.text,
        mask: `mod_${ctx.hash(`pkg:${name.text}`)}`,
        spans: [spanOf(name)],
      });
    }
  }

  // ── 2. Imports: classify by path; mask internal path + qualifier + selectors. ──
  for (const spec of collect(root, ["import_spec"])) {
    const pathNode = spec.childForFieldName("path");
    if (!pathNode) continue;
    importPathNodes.add(pathNode.id);
    const path = pathNode.text.slice(1, -1);
    if (!isInternalPath(path, ctx.prefixes)) continue; // external/stdlib — never touch

    const aliasNode = spec.childForFieldName("name");
    // Dot/blank imports bind no resolvable qualifier — leave the import alone
    // rather than break the path↔qualifier correspondence (safe under-mask).
    if (aliasNode && aliasNode.type !== "package_identifier") continue;
    const qualifier = aliasNode?.text ?? path.split("/").pop() ?? path;
    if (locals.has(qualifier)) continue; // shadowed — skip the whole import (see above)

    const h = ctx.hash(path);
    symbols.push({
      kind: "module-specifier",
      real: path,
      mask: `masked/mod_${h}`,
      spans: [innerSpan(pathNode)],
    });

    // Qualifier occurrences: the alias (if any), selector operands, qualified types.
    const qualifierSpans = aliasNode ? [spanOf(aliasNode)] : [];
    const selectorTargets = new Map<string, SymbolTarget>();
    walk(root, (n) => {
      if (n.type === "selector_expression") {
        const operand = n.childForFieldName("operand");
        const field = n.childForFieldName("field");
        if (operand?.type === "identifier" && operand.text === qualifier && field) {
          qualifierSpans.push(spanOf(operand));
          const key = field.text;
          const existing = selectorTargets.get(key);
          if (existing) existing.spans.push(spanOf(field));
          else
            selectorTargets.set(key, {
              kind: "import",
              real: key,
              mask: ctx.maskId(`${path}.${key}`, "import"),
              spans: [spanOf(field)],
            });
        }
      }
      if (n.type === "qualified_type") {
        const pkg = n.childForFieldName("package");
        const name = n.childForFieldName("name");
        if (pkg?.text === qualifier && name) {
          qualifierSpans.push(spanOf(pkg));
          const key = name.text;
          const existing = selectorTargets.get(key);
          if (existing) existing.spans.push(spanOf(name));
          else
            selectorTargets.set(key, {
              kind: "import",
              real: key,
              mask: ctx.maskId(`${path}.${key}`, "import"),
              spans: [spanOf(name)],
            });
        }
      }
    });
    if (qualifierSpans.length > 0) {
      symbols.push({ kind: "namespace", real: qualifier, mask: `mod_${h}`, spans: qualifierSpans });
    }
    symbols.push(...selectorTargets.values());
  }

  // ── 3. Internally-declared types + top-level functions. ──
  // (method_declaration is deliberately absent: members are off.)
  const declared = new Map<string, SymbolTarget>();
  for (const spec of collect(root, ["type_spec"])) {
    const name = spec.childForFieldName("name");
    if (!name) continue;
    const kind = typeSpecKind(spec);
    declared.set(name.text, {
      kind,
      real: name.text,
      mask: ctx.maskId(name.text, kind),
      spans: [],
    });
  }
  for (const fn of collect(root, ["function_declaration"])) {
    const name = fn.childForFieldName("name");
    if (!name || name.text === "main" || name.text === "init") continue; // entrypoints must keep their names
    declared.set(name.text, {
      kind: "function",
      real: name.text,
      mask: ctx.maskId(name.text, "function"),
      spans: [],
    });
  }

  // Every resolved occurrence: plain identifiers + type identifiers. Members
  // (field_identifier) are a different node type and are skipped by
  // construction; composite-literal keys are guarded explicitly.
  walk(root, (n) => {
    if (n.type !== "identifier" && n.type !== "type_identifier") return;
    const target = declared.get(n.text);
    if (!target) return;
    const parent = n.parent;
    // `Foo{Bar: x}` — a keyed-element key is a FIELD name, never a reference.
    if (parent?.type === "keyed_element" && parent.child(0)?.id === n.id) return;
    target.spans.push(spanOf(n));
  });
  symbols.push(...declared.values());

  // ── 4. String literals (minus import paths) + comments. ──
  walk(root, (n) => {
    if (n.type === "interpreted_string_literal" || n.type === "raw_string_literal") {
      if (importPathNodes.has(n.id)) return;
      const span = innerSpan(n);
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    }
    if (n.type === "comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
