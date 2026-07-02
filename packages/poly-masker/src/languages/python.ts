import type { Node } from "web-tree-sitter";
import { collect, hasAncestor, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, LangAnalysis, SymbolTarget } from "../types.js";

/**
 * Python analyzer — deliberately the LAST language built (dynamic typing).
 *
 * Classification signal: the import system.
 *   - relative imports (`from .models import LedgerEntry`) are INTERNAL
 *   - absolute imports are internal only when the module path falls under a
 *     configured internal top-level package (internalPackagePrefixes.python,
 *     e.g. "voltra_billing"); stdlib and pip packages never match and are
 *     never touched
 *   - the file's own module-level declarations are internal by definition
 *
 * DYNAMIC-TYPING CAUTION (the TS `any` rule applied wholesale): members are
 * NEVER masked. `self.ledger_client.post_entry(...)` — attribute access is
 * unresolvable without types, so attribute positions are excluded from
 * renames entirely; a member is masked only if every access site resolves,
 * which syntactically is "never". The exception is MODULE attribute chains
 * we can resolve textually: `voltra_billing.ledger` after
 * `import voltra_billing.ledger` renames segment-by-segment, consistently
 * with the rewritten import.
 *
 * Docstrings are stripped along with `#` comments: they are Python's doc
 * comments (the Javadoc/KDoc analog) and the same leak channel.
 */

function isInternalModule(module: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => p.length > 0 && (module === p || module.startsWith(p.endsWith(".") ? p : `${p}.`)),
  );
}

/** Member positions (attribute accesses, keyword args) — never renamed. */
function isMemberPosition(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (p.type === "attribute" && p.childForFieldName("attribute")?.id === n.id) return true;
  if (p.type === "keyword_argument" && p.childForFieldName("name")?.id === n.id) return true;
  return false;
}

export function analyzePython(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const comments: LangAnalysis["comments"] = [];
  const renameTargets = new Map<string, SymbolTarget>();
  /** Internal dotted module paths whose attribute CHAINS we rename textually. */
  const moduleChains: string[] = [];

  const maskModule = (path: string) => `mod_${ctx.hash(`mod:${path}`)}`;

  // ── 1. Imports. ──
  // `import a.b` / `import a.b as x`
  for (const imp of collect(root, ["import_statement"])) {
    for (const child of imp.namedChildren) {
      if (!child) continue;
      const pathNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
      if (!pathNode || pathNode.type !== "dotted_name") continue;
      const path = pathNode.text;
      if (!isInternalModule(path, ctx.prefixes)) continue; // stdlib/pip — never touch

      // Rewrite the dotted path segment-by-segment so refs stay consistent:
      // `import voltra_billing.ledger` -> `import mod_h1.mod_h2`.
      const segments = path.split(".");
      const maskedPath = segments
        .map((_, i) => maskModule(segments.slice(0, i + 1).join(".")))
        .join(".");
      symbols.push({ kind: "module-specifier", real: path, mask: maskedPath, spans: [spanOf(pathNode)] });

      const alias = child.type === "aliased_import" ? child.childForFieldName("alias") : null;
      if (alias) {
        // The alias binds the module: rename the alias + its references.
        if (!renameTargets.has(alias.text)) {
          renameTargets.set(alias.text, {
            kind: "namespace",
            real: alias.text,
            mask: maskModule(path),
            spans: [spanOf(alias)],
          });
        }
      } else {
        // Unaliased: code references the dotted chain — rename the top
        // segment + textual attribute chains (`a.b` handled in step 4).
        const top = segments[0]!;
        if (!renameTargets.has(top)) {
          renameTargets.set(top, { kind: "namespace", real: top, mask: maskModule(top), spans: [] });
        }
        moduleChains.push(path);
      }
    }
  }

  // `from X import a, b as c` / `from . import x`
  for (const imp of collect(root, ["import_from_statement"])) {
    const moduleNode = imp.childForFieldName("module_name");
    if (!moduleNode) continue;
    const relative = moduleNode.type === "relative_import";
    const moduleText = moduleNode.text;
    const absPath = moduleText.replace(/^\.+/, "");
    const internal = relative || isInternalModule(moduleText, ctx.prefixes);
    if (!internal) continue;
    const isWildcard = imp.namedChildren.some((c) => c?.type === "wildcard_import");

    // Rewrite the module path (keep leading dots of a relative import).
    if (absPath.length > 0) {
      const dotted = relative ? collect(moduleNode, ["dotted_name"])[0] : moduleNode;
      if (dotted) {
        symbols.push({
          kind: "module-specifier",
          real: absPath,
          mask: `mod_${ctx.hash(`mod:${moduleText}`)}`,
          spans: [spanOf(dotted)],
        });
      }
    }
    if (isWildcard) continue; // `from .x import *` — unenumerable bindings, skip

    for (const child of imp.namedChildren) {
      if (!child || child.id === moduleNode.id) continue;
      const nameNode = child.type === "aliased_import" ? child.childForFieldName("alias") : child;
      const importedNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
      if (!nameNode || nameNode.type !== "dotted_name" && nameNode.type !== "identifier") continue;
      const bound = nameNode.text;
      if (renameTargets.has(bound)) continue;
      renameTargets.set(bound, {
        kind: "import",
        real: bound,
        mask: ctx.maskId(`${moduleText}.${importedNode?.text ?? bound}`, "import"),
        // The binding inside the import statement is renamed here; references
        // are collected in step 4 (imports are excluded there).
        spans: [spanOf(nameNode)],
      });
    }
  }

  // ── 2. Module-level declarations (methods/nested defs are members — off). ──
  for (const def of collect(root, ["class_definition", "function_definition"])) {
    if (hasAncestor(def, ["class_definition", "function_definition"])) continue;
    const name = def.childForFieldName("name");
    if (!name || renameTargets.has(name.text)) continue;
    const kind = def.type === "class_definition" ? "class" : "function";
    renameTargets.set(name.text, { kind, real: name.text, mask: ctx.maskId(name.text, kind), spans: [] });
  }

  // ── 2b. Index-resolved names. ──
  for (const name of ctx.extraInternalTypes) {
    if (!renameTargets.has(name)) {
      renameTargets.set(name, { kind: "import", real: name, mask: ctx.maskId(name, "import"), spans: [] });
    }
  }

  // ── 3. Textual module attribute chains for unaliased dotted imports:
  // an `attribute` node whose FULL text equals an internal chain prefix has
  // its attribute segment renamed consistently with the import rewrite. ──
  walk(root, (n) => {
    if (n.type !== "attribute") return;
    const text = n.text;
    for (const chain of moduleChains) {
      if (chain === text || chain.startsWith(`${text}.`)) {
        const attr = n.childForFieldName("attribute");
        if (attr) {
          symbols.push({
            kind: "namespace",
            real: attr.text,
            mask: maskModule(text),
            spans: [spanOf(attr)],
          });
        }
        break;
      }
    }
  });

  // ── 4. Every resolved occurrence of a rename target. ──
  walk(root, (n) => {
    if (n.type !== "identifier") return;
    const target = renameTargets.get(n.text);
    if (!target) return;
    if (hasAncestor(n, ["import_statement", "import_from_statement"])) return;
    if (isMemberPosition(n)) return;
    target.spans.push(spanOf(n));
  });
  symbols.push(...renameTargets.values());

  // ── 5. Strings (content spans — f-string {…} interpolations excluded),
  //       docstrings (deleted like comments), and # comments. ──
  const docstringStrings = new Set<number>();
  for (const stmt of collect(root, ["expression_statement"])) {
    // A docstring: a lone string as the FIRST statement of a module/class/def body.
    if (stmt.namedChildCount !== 1 || stmt.namedChild(0)?.type !== "string") continue;
    const parent = stmt.parent;
    const isBodyStart =
      (parent?.type === "module" || parent?.type === "block") && parent.namedChild(0)?.id === stmt.id;
    const owner = parent?.type === "block" ? parent.parent?.type : "module";
    if (isBodyStart && (owner === "module" || owner === "class_definition" || owner === "function_definition")) {
      comments.push(spanOf(stmt));
      docstringStrings.add(stmt.namedChild(0)!.id);
    }
  }
  walk(root, (n) => {
    if (n.type === "string_content" && !docstringStrings.has(n.parent?.id ?? -1)) {
      strings.push({ span: spanOf(n), text: n.text });
    }
    if (n.type === "comment") comments.push(spanOf(n));
  });

  return { symbols, strings, comments };
}
