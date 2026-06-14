/**
 * @wyloc/code-masker — AST-based, semantic-preserving TS/JS identifier masking.
 *
 * The code-structure analog of @wyloc/sql-masker: mask proprietary identity
 * (internal classes/functions/types/members, internal URLs/hosts/IPs/paths,
 * hardcoded secrets), preserve meaning (external/library APIs, business logic,
 * control flow) so an LLM can still understand and help — then rehydrate its
 * response in-session. Comments are stripped wholesale (a leak channel with
 * negligible value to the model).
 */
export { CodeMasker, type MaskResult } from "./engine.js";
export { rehydrate } from "./rehydrate.js";
export { SessionMap } from "./session.js";
export {
  resolveConfig,
  type CodeMaskerConfig,
  type CodeMaskerConfigInput,
} from "./config.js";
export { collectMaskedSymbols, importOrigin, type MaskedSymbol } from "./classify.js";
export { maskStringValue, type StringHit, type StringMaskResult } from "./strings.js";
export {
  maskIdentifier,
  maskModuleSpecifier,
  maskHost,
  maskPrivateIp,
  maskPath,
  maskToken,
} from "./mask.js";
export type { MaskKind, MaskEntry, ClassifiedSymbol } from "./types.js";
