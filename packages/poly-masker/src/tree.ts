import type { Node } from "web-tree-sitter";
import type { Span } from "./types.js";

/** Depth-first walk over NAMED nodes (tree-sitter's `comment` nodes are named). */
export function walk(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, fn);
  }
}

/** All named descendants (including `node`) whose type is in `types`. */
export function collect(node: Node, types: readonly string[]): Node[] {
  const out: Node[] = [];
  walk(node, (n) => {
    if (types.includes(n.type)) out.push(n);
  });
  return out;
}

/** ERROR + missing nodes — the parse-quality gate for both input and output. */
export function countParseErrors(root: Node): number {
  let errors = 0;
  walk(root, (n) => {
    if (n.type === "ERROR" || n.isMissing) errors++;
  });
  return errors;
}

export function spanOf(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex };
}

/** Whether any ancestor (not `node` itself) has a type in `types`. */
export function hasAncestor(node: Node, types: readonly string[]): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (types.includes(p.type)) return true;
  }
  return false;
}

/**
 * The content span of a quoted string literal node: the node span minus the
 * quote characters actually present in the source (works for ", ', `, and
 * multi-char quotes like Python's triple quotes when lengths are passed in).
 */
export function innerSpan(node: Node, quoteLen = 1): Span {
  return { start: node.startIndex + quoteLen, end: node.endIndex - quoteLen };
}
