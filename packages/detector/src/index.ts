/**
 * @wyloc/detector — public entry point.
 *
 * Local-first secret detection for AI-DLP. Zero dependencies, no DOM and
 * no Node APIs, so the exact same compiled code runs inside the browser
 * extension, the VS Code / Cursor plugin, and the CLI.
 *
 * Primary API:
 *   scan(text, config?)  ->  ScanResult { findings, decision, textLength }
 */

import type {
  DetectorConfig,
  ScanResult,
  IncidentMetadata,
} from "./types.js";
import { resolveConfig } from "./config.js";
import { detect } from "./scanner.js";
import { decide } from "./policy.js";
import { buildIncidents } from "./incident.js";

export type {
  DetectorConfig,
  ScanResult,
  Finding,
  PolicyDecision,
  Action,
  Confidence,
  SecretType,
  DetectionLayer,
  Environment,
  IncidentMetadata,
} from "./types.js";

export { defaultConfig, resolveConfig } from "./config.js";
export { redact, maskValue } from "./redact.js";
export { buildSwap, rehydrate } from "./swap.js";
export type { SwapMapping, SwapResult } from "./swap.js";
export { toIncidentMetadata, buildIncidents } from "./incident.js";
// The compiled pattern table is the runtime source of truth. SECRET_PATTERNS
// is kept as a backwards-compatible alias for existing importers.
export {
  COMPILED_PATTERNS,
  COMPILED_PATTERNS as SECRET_PATTERNS,
} from "./patterns/compiled.generated.js";
export type { CompiledPattern, PatternDefinition, PatternTier } from "./patterns/schema.js";

/**
 * Scan a block of text for secrets and compute the policy decision.
 *
 * This is the single call every surface makes. It is synchronous, pure,
 * and fast enough to run on a paste/submit event without debouncing for
 * typical prompt-sized inputs.
 *
 * @param text   The prompt / buffer / clipboard text to inspect.
 * @param config Optional partial config; merged over safe defaults.
 */
export function scan(
  text: string,
  config?: Partial<DetectorConfig>,
): ScanResult {
  const cfg: DetectorConfig = resolveConfig(config);
  const findings = detect(text, cfg);
  const decision = decide(findings);
  return {
    findings,
    decision,
    textLength: text.length,
  };
}

/**
 * Convenience: scan and immediately produce metadata-only incident
 * records. Useful for surfaces that log every non-allow finding.
 */
export function scanToIncidents(
  text: string,
  tool: IncidentMetadata["tool"],
  config?: Partial<DetectorConfig>,
): { result: ScanResult; incidents: IncidentMetadata[] } {
  const result = scan(text, config);
  const incidents = buildIncidents(
    result.findings,
    result.decision.perFinding,
    tool,
  );
  return { result, incidents };
}
