/**
 * Merge a loaded wyloc.json over the env-based GatewayConfig.
 *
 * PRECEDENCE (deliberate, for a security tool): wyloc.json > env > defaults for
 * SECURITY-POLICY fields. Company policy is authoritative — a stray local env
 * var must not silently weaken a fleet-wide rule. Operational fields (port,
 * host, upstream URLs) are untouched here and remain env-driven. When no file
 * is present the gateway runs exactly as before (env/defaults).
 */

import type { GatewayConfig } from "../config.js";
import type { LoadedWylocConfig } from "./load.js";

export function applyWyloc(env: GatewayConfig, w: LoadedWylocConfig): GatewayConfig {
  // PII category toggles are expressed as detector rule suppressions.
  const suppressedRuleIds = [
    ...(env.detector.suppressedRuleIds ?? []),
    ...w.suppressedRuleIds,
  ];

  return {
    ...env,
    // Policy toggles: wyloc value wins when present, else keep env/default.
    maskSql: w.policy.sql ?? env.maskSql,
    maskCode: w.policy.code ?? env.maskCode,
    maskFileReads: w.policy.fileReads ?? env.maskFileReads,
    maskCodeMembers: w.policy.members ?? env.maskCodeMembers,

    // Detector: append org custom patterns + PII suppressions to the shared
    // engine config, which flows to every scan() call (message text, file
    // reads, and the sql/code masker literal passes).
    detector: {
      ...env.detector,
      customPatterns: [
        ...(env.detector.customPatterns ?? []),
        ...w.customPatterns,
      ],
      suppressedRuleIds,
    },

    // Poly-masker: the languages LIST is authoritative when present (a policy
    // choice, like the toggles above); prefixes merge (both only ever add).
    maskLanguages: w.languages ?? env.maskLanguages,
    internalPackagePrefixes: mergePrefixMaps(env.internalPackagePrefixes, w.internalPackagePrefixes),

    // Code-masker inputs.
    internalScopes: [...env.internalScopes, ...w.internalScopes],
    internalDomains: [...env.internalDomains, ...w.internalDomains],
    internalTlds: [...env.internalTlds, ...w.internalTlds],
    blocklistSubstrings: [...env.blocklistSubstrings, ...w.blocklistSubstrings],
  };
}

function mergePrefixMaps(
  a: Partial<Record<string, string[]>>,
  b: Partial<Record<string, string[]>>,
): Partial<Record<string, string[]>> {
  const out: Partial<Record<string, string[]>> = { ...a };
  for (const [lang, prefixes] of Object.entries(b)) {
    if (!prefixes) continue;
    out[lang] = [...new Set([...(out[lang] ?? []), ...prefixes])];
  }
  return out;
}
