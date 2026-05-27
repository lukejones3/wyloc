/**
 * Incident metadata construction — plan Section 9.
 *
 * This is the ONLY path by which information about a finding may leave
 * the machine. By construction the output type (`IncidentMetadata`) has
 * no field that can hold prompt text, code context, or a secret value.
 * The `value` on a Finding is deliberately not copied here.
 */

import type { Finding, IncidentMetadata, Action } from "./types.js";

/**
 * Convert a finding + its policy action into a metadata-only incident
 * record. Safe to log locally and to send to the control plane.
 */
export function toIncidentMetadata(
  finding: Finding,
  action: Action,
  tool: IncidentMetadata["tool"],
  timestamp: string = new Date().toISOString(),
): IncidentMetadata {
  return {
    timestamp,
    tool,
    secretType: finding.type,
    layer: finding.layer,
    confidence: finding.confidence,
    environment: finding.environment,
    action,
    ruleId: finding.ruleId,
  };
}

/**
 * Build incident records for an entire scan. `actions` must be index-
 * aligned with `findings` (as produced by the policy engine).
 *
 * Only findings whose action is `warn` or `block` become incidents —
 * an `allow` is a non-event and is not logged.
 */
export function buildIncidents(
  findings: Finding[],
  actions: Action[],
  tool: IncidentMetadata["tool"],
  timestamp?: string,
): IncidentMetadata[] {
  const incidents: IncidentMetadata[] = [];
  findings.forEach((f, i) => {
    const action = actions[i] ?? "warn";
    if (action === "allow") return;
    incidents.push(toIncidentMetadata(f, action, tool, timestamp));
  });
  return incidents;
}
