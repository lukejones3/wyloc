import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, IdentifierKind, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * C analyzer — the weakest classification signal of the family (no module
 * system), so the most conservative.
 *
 * Classification:
 *  - `#include <…>` (system) = external, never touch; `#include "…"` (local)
 *    = project identity — the PATH is masked, and names DECLARED in local
 *    headers resolve via the project index (ctx.extraInternalTypes) on the
 *    file-read path; on the snippet path they are left alone (under-mask).
 *  - declared in the visible file (functions incl. static prototypes,
 *    struct/union/enum tags with bodies, typedefs) = internal.
 *
 * PREPROCESSOR CONSERVATISM (the Tier-2 rule): the preprocessor can alias or
 * generate identifiers, so anything it obscures is LEFT ALONE:
 *  - every `#define`d name goes into a hard never-mask set — masking a macro
 *    name risks breaking token pasting / conditional compilation, and a name
 *    that is both declared and #define'd is ambiguous by definition
 *  - no renames inside macro definitions or #if/#ifdef CONDITION expressions
 *    (the BODIES of #if blocks are ordinary code and are processed normally)
 *  - struct members / field accesses are members (off)
 * C under-masks more than the statically-clean languages; that is the
 * intended safe failure, not a bug.
 */

/** Contexts whose contents the preprocessor owns — never rename inside. */
const PREPROC_DEF_CONTEXTS = ["preproc_def", "preproc_function_def"];

/** Walk a declarator chain (pointers, functions, arrays) down to its name. */
export function declaratorName(node: Node | null): Node | null {
  let d = node;
  while (d) {
    if (d.type === "identifier" || d.type === "type_identifier" || d.type === "field_identifier") return d;
    d = d.childForFieldName("declarator") ?? null;
  }
  return null;
}

/** Is this identifier inside an #if/#ifdef/#elif CONDITION (not the body)? */
function inPreprocCondition(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (
      (p.type === "preproc_if" || p.type === "preproc_elif") &&
      p.childForFieldName("condition") &&
      n.startIndex >= p.childForFieldName("condition")!.startIndex &&
      n.endIndex <= p.childForFieldName("condition")!.endIndex
    )
      return true;
    if (p.type === "preproc_ifdef") {
      const name = p.childForFieldName("name");
      if (name && name.id === n.id) return true;
    }
  }
  return false;
}

export function analyzeC(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];
  const renameTargets = new Map<string, SymbolTarget>();
  const includePathNodes = new Set<number>();

  // ── 1. #define names: the hard never-mask set. ──
  const defined = new Set<string>();
  for (const def of collect(root, PREPROC_DEF_CONTEXTS)) {
    const name = def.childForFieldName("name");
    if (name) defined.add(name.text);
  }

  // ── 2. Includes: local paths masked; system includes never touched. ──
  for (const inc of collect(root, ["preproc_include"])) {
    const path = inc.childForFieldName("path");
    if (!path) continue;
    if (path.type === "string_literal") {
      includePathNodes.add(path.id);
      const real = path.text.slice(1, -1);
      const ext = real.match(/\.[a-zA-Z]+$/)?.[0] ?? ".h";
      symbols.push({
        kind: "module-specifier",
        real,
        mask: `masked_mod_${ctx.hash(`inc:${real}`)}${ext}`,
        spans: [{ start: path.startIndex + 1, end: path.endIndex - 1 }],
      });
    }
  }

  const declare = (name: string, kind: IdentifierKind): void => {
    if (renameTargets.has(name) || defined.has(name) || name === "main") return;
    renameTargets.set(name, { kind, real: name, mask: ctx.maskId(name, kind), spans: [] });
  };

  // ── 3. Declarations in the visible file. ──
  for (const fn of collect(root, ["function_definition"])) {
    const name = declaratorName(fn.childForFieldName("declarator"));
    if (name) declare(name.text, "function");
  }
  // static/extern prototypes at top level
  for (const decl of collect(root, ["declaration"])) {
    if (decl.parent?.type !== "translation_unit") continue;
    const declarator = decl.childForFieldName("declarator");
    if (declarator?.type === "function_declarator" || declarator?.type === "pointer_declarator") {
      const inner = declarator.type === "pointer_declarator" ? declarator.childForFieldName("declarator") : declarator;
      if (inner?.type === "function_declarator") {
        const name = declaratorName(inner);
        if (name) declare(name.text, "function");
      } else if (declarator.type === "function_declarator") {
        const name = declaratorName(declarator);
        if (name) declare(name.text, "function");
      }
    }
  }
  for (const spec of collect(root, ["struct_specifier", "union_specifier", "enum_specifier"])) {
    if (!spec.childForFieldName("body")) continue; // reference, not definition
    const name = spec.childForFieldName("name");
    if (name) declare(name.text, "type");
  }
  for (const td of collect(root, ["type_definition"])) {
    const name = declaratorName(td.childForFieldName("declarator"));
    if (name) declare(name.text, "type");
  }

  // ── 3b. Local-header names from the project index. ──
  for (const name of ctx.extraInternalTypes) {
    if (!defined.has(name)) declare(name, "import");
  }

  // ── 4. Every resolved occurrence. ──
  walk(root, (n) => {
    if (n.type !== "identifier" && n.type !== "type_identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, PREPROC_DEF_CONTEXTS)) return; // macro bodies — never
    if (hasAncestor(n, ["preproc_include"])) return; // path edit covers it
    if (inPreprocCondition(n)) return; // #if conditions — never
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 5. Strings (leaf literals incl. quotes) + comments. #define VALUES are
  //       raw preproc_arg tokens, not string_literal nodes — quoted strings
  //       inside them are extracted textually (substring masking of literal
  //       CONTENT is safe even in macros; only identifier renames are gated). ──
  walk(root, (n) => {
    if (n.type === "string_literal" && !includePathNodes.has(n.id)) {
      const span = { start: n.startIndex + 1, end: n.endIndex - 1 };
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    }
    if (n.type === "preproc_arg") {
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
