/** Public shared types for @wyloc/code-masker. */

/**
 * What an identifier/value was classified as. Drives the mask scheme and is
 * recorded in the session map for rehydration.
 *
 *  - class/function/interface/type/enum/namespace: internally-DEFINED top-level
 *    declarations (Bucket 1 — always mask).
 *  - member: a method / property on an internally-defined class or interface.
 *  - import: a name bound by a RELATIVE import (defined elsewhere in the project).
 *  - module-specifier: the relative import path string itself (reveals architecture).
 *  - string: an internal URL / host / IP / path / Bucket-2 reference inside a literal.
 *  - secret: a hardcoded credential swapped via @wyloc/detector.
 */
export type MaskKind =
  | "class"
  | "function"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "member"
  | "import"
  | "module-specifier"
  | "string"
  | "secret";

/** One real->mask mapping recorded in the session. */
export interface MaskEntry {
  kind: MaskKind;
  real: string;
  mask: string;
}

/** The classification a maskable identifier declaration falls into. */
export interface ClassifiedSymbol {
  kind: MaskKind;
  /** The original (real) identifier text. */
  real: string;
}
