/**
 * @wyloc/poly-masker — tree-sitter-based, semantic-preserving identifier
 * masking for Go / Java / C# / Kotlin / Python.
 *
 * The multi-language sibling of @wyloc/code-masker (TS/JS keeps the TypeScript
 * Compiler API): mask proprietary identity (internal types/functions/packages,
 * internal import paths, internal URLs/hosts/IPs/paths in literals, hardcoded
 * secrets), preserve meaning (stdlib + third-party APIs, business logic,
 * control flow), strip comments — then rehydrate the model's response
 * in-session. Session map, string-literal pass, mask shapes, and rehydration
 * are shared with the TS masker so masks look and reverse identically across
 * every language the gateway handles.
 */
export { PolyMasker, PolyMaskError, IMPLEMENTED_LANGUAGES, type MaskResult } from "./engine.js";
export { resolveConfig, type PolyMaskerConfig, type PolyMaskerConfigInput } from "./config.js";
export { discoverInternalPrefixes } from "./discover.js";
export { ProjectIndex } from "./project-index.js";
export { SessionMap, rehydrate } from "@wyloc/code-masker";
export { LANGUAGE_IDS, type LanguageId, type MaskKind } from "./types.js";
