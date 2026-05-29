/**
 * The scanner orchestrates all detection layers into a single, ordered,
 * deduplicated list of findings.
 *
 * Pipeline (plan Section 5):
 *   Layer 1  known vendor patterns      -> findings
 *   Layer 2  entropy                    -> findings (low/medium only)
 *   Layer 3  structural assignments     -> findings
 *   Layer 4  context gating             -> adjusts confidence + env
 *   Layer 5  allowlist suppression      -> drops findings
 *
 * Overlap resolution: when two layers flag overlapping spans, the
 * higher-confidence / more-specific finding wins. A precise AWS key
 * match should not also surface as a vague entropy hit.
 */

import type { DetectorConfig, Finding } from "./types.js";
import type { CompiledPattern } from "./patterns/schema.js";
import { COMPILED_PATTERNS } from "./patterns/compiled.generated.js";
import {
  shannonEntropy,
  extractTokens,
  looksLikeHashOrUuid,
  looksLikeIdentifier,
  hasSecretLikeCharMix,
} from "./layers/entropy.js";
import { findStructuralMatches } from "./layers/structural.js";
import {
  hasNearbyContext,
  inferEnvironment,
  isAllowlisted,
  raiseConfidence,
  lowerConfidence,
} from "./layers/context.js";

function spansOverlap(a: Finding, b: Finding): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Specificity score for overlap resolution — higher wins. */
function specificity(f: Finding): number {
  const layerRank = { known_pattern: 3, structural: 2, entropy: 1, context: 0 };
  const confRank = { high: 3, medium: 2, low: 1 };
  return layerRank[f.layer] * 10 + confRank[f.confidence];
}

// --- Layer 1: compiled vendor patterns ---------------------------------
//
// All patterns come from the build-time-compiled table (COMPILED_PATTERNS),
// generated from src/patterns/definitions/*.json. The runtime never parses
// those JSON files — it consumes the pre-built RegExp table here. Each
// pattern is evaluated by its declared tier:
//
//   tier_1 / tier_2  regex match -> finding. tier_2 may run an optional
//                    structural validation hook. Nearby context can lift a
//                    medium match to high (same as the old known-pattern
//                    behaviour).
//   tier_3           generic high-entropy blob with no fixed prefix. Fires
//                    ONLY when it clears the entropy floor, looks secret-like
//                    (mixed charset, not a hash/UUID), and a hard context
//                    gate opens (a requiredContext keyword OR the optional
//                    contextRegex within the window). This is the machinery
//                    that keeps a prefix-less 40-char blob from wrecking the
//                    false-positive rate — see the AWS secret access key.

/**
 * Resolve a match's reported value + start, honouring an optional capture
 * group (used when the regex must match surrounding context but only the
 * group is the secret, e.g. `aws_secret_access_key=<value>`).
 */
function matchSpan(
  pat: CompiledPattern,
  m: RegExpExecArray,
): { value: string; start: number } {
  const cg = pat.captureGroup;
  if (cg !== undefined && m[cg] !== undefined) {
    const value = m[cg] as string;
    return { value, start: m.index + m[0].indexOf(value) };
  }
  return { value: m[0], start: m.index };
}

/** tier_1 / tier_2 evaluation. */
function runPrefixedOrStructural(
  pat: CompiledPattern,
  text: string,
  cfg: DetectorConfig,
  out: Finding[],
): void {
  pat.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pat.regex.exec(text)) !== null) {
    const { value, start } = matchSpan(pat, m);
    const end = start + value.length;
    // Guard against zero-width matches.
    if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;

    // tier_2: optional deeper structural validation hook.
    if (pat.structuralValidator && !pat.structuralValidator(value)) continue;
    if (isAllowlisted(text, start, end, value, cfg.allowlist)) continue;

    let confidence = pat.confidence;
    // Context can lift a medium vendor match to high.
    if (
      confidence !== "high" &&
      hasNearbyContext(text, start, end, cfg.contextWindow)
    ) {
      confidence = raiseConfidence(confidence);
    }
    out.push({
      layer: "known_pattern",
      type: pat.type,
      confidence,
      start,
      end,
      value,
      environment: inferEnvironment(text, start, end, cfg.contextWindow),
      reason: pat.reason,
      ruleId: pat.id,
    });
  }
}

/** The hard tier_3 gate: a requiredContext keyword OR the contextRegex. */
function tier3GateOpen(
  pat: CompiledPattern,
  text: string,
  start: number,
  end: number,
  radius: number,
): boolean {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const w = text.slice(from, to);
  // An optional structural signal (e.g. an AKIA access key id beside the
  // candidate) is matched against the original-case window.
  if (pat.contextRegex) {
    pat.contextRegex.lastIndex = 0;
    if (pat.contextRegex.test(w)) return true;
  }
  const lw = w.toLowerCase();
  return (pat.requiredContext ?? []).some((kw) => lw.includes(kw));
}

/** tier_3 evaluation: generic high-entropy blob, context-gated. */
function runGenericHighEntropy(
  pat: CompiledPattern,
  text: string,
  cfg: DetectorConfig,
  out: Finding[],
): void {
  const threshold = pat.entropyThreshold ?? Infinity;
  pat.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pat.regex.exec(text)) !== null) {
    const { value, start } = matchSpan(pat, m);
    const end = start + value.length;
    // Guard against zero-width matches.
    if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;

    // Reject hashes/UUIDs and single-character-class blobs, and require the
    // entropy of a real key. Mirrors the entropy layer's own guards.
    if (looksLikeHashOrUuid(value)) continue;
    if (!hasSecretLikeCharMix(value)) continue;
    if (shannonEntropy(value) < threshold) continue;
    // The hard gate: only emit when required context is nearby.
    if (!tier3GateOpen(pat, text, start, end, cfg.contextWindow)) continue;
    if (isAllowlisted(text, start, end, value, cfg.allowlist)) continue;

    out.push({
      layer: "known_pattern",
      type: pat.type,
      confidence: pat.confidence,
      start,
      end,
      value,
      environment: inferEnvironment(text, start, end, cfg.contextWindow),
      reason: pat.reason,
      ruleId: pat.id,
    });
  }
}

function runPatterns(text: string, cfg: DetectorConfig): Finding[] {
  const out: Finding[] = [];
  for (const pat of COMPILED_PATTERNS) {
    if (pat.tier === "tier_3") {
      runGenericHighEntropy(pat, text, cfg, out);
    } else {
      runPrefixedOrStructural(pat, text, cfg, out);
    }
  }
  return out;
}

// --- Layer 2 -----------------------------------------------------------
function runEntropy(text: string, cfg: DetectorConfig): Finding[] {
  const out: Finding[] = [];
  for (const tok of extractTokens(text, cfg.entropyMinLength)) {
    if (looksLikeHashOrUuid(tok.text)) continue;
    if (looksLikeIdentifier(tok.text)) continue;
    if (!hasSecretLikeCharMix(tok.text)) continue;

    const entropy = shannonEntropy(tok.text);
    if (entropy < cfg.entropyThreshold) continue;
    if (isAllowlisted(text, tok.start, tok.end, tok.text, cfg.allowlist)) {
      continue;
    }

    const contextual = hasNearbyContext(
      text,
      tok.start,
      tok.end,
      cfg.contextWindow,
    );
    // Entropy alone is weak. Without context it is, at best, a low-
    // confidence warning — and if the config requires context, dropped.
    if (!contextual && cfg.requireContextForEntropy) continue;

    out.push({
      layer: "entropy",
      type: "high_entropy_string",
      confidence: contextual ? "medium" : "low",
      start: tok.start,
      end: tok.end,
      value: tok.text,
      environment: inferEnvironment(
        text,
        tok.start,
        tok.end,
        cfg.contextWindow,
      ),
      reason: contextual
        ? "High-entropy string near a credential-related keyword."
        : "High-entropy string that may be a secret.",
      ruleId: "entropy.high_entropy_string",
    });
  }
  return out;
}

// --- Layer 3 -----------------------------------------------------------
function runStructural(text: string, cfg: DetectorConfig): Finding[] {
  const out: Finding[] = [];
  for (const sm of findStructuralMatches(text)) {
    if (isAllowlisted(text, sm.start, sm.end, sm.value, cfg.allowlist)) {
      continue;
    }
    // Base medium; raise to high if the value itself is high-entropy AND
    // the key or surroundings are credential-flavoured.
    let confidence: Finding["confidence"] = "medium";
    const entropy = shannonEntropy(sm.value);
    const contextual =
      hasNearbyContext(text, sm.start, sm.end, cfg.contextWindow) ||
      sm.key.length > 0;
    if (entropy >= 4.0 && contextual && hasSecretLikeCharMix(sm.value)) {
      confidence = raiseConfidence(confidence);
    } else if (entropy < 3.0) {
      confidence = lowerConfidence(confidence);
    }
    out.push({
      layer: "structural",
      type: "env_assignment",
      confidence,
      start: sm.start,
      end: sm.end,
      value: sm.value,
      environment: inferEnvironment(
        text,
        sm.start,
        sm.end,
        cfg.contextWindow,
      ),
      reason: `Credential-style assignment (\`${sm.key}\`) detected.`,
      ruleId: sm.ruleId,
    });
  }
  return out;
}

/** Resolve overlaps: keep the most specific finding per overlapping cluster. */
function dedupe(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: Finding[] = [];
  for (const f of sorted) {
    const clash = kept.findIndex((k) => spansOverlap(k, f));
    if (clash === -1) {
      kept.push(f);
      continue;
    }
    const existing = kept[clash]!;
    if (specificity(f) > specificity(existing)) {
      kept[clash] = f;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Run all detection layers and return a deduplicated, position-sorted
 * list of findings. Pure function — no I/O, no globals mutated.
 */
export function detect(text: string, cfg: DetectorConfig): Finding[] {
  if (text.length === 0) return [];
  const raw = [
    ...runPatterns(text, cfg),
    ...runEntropy(text, cfg),
    ...runStructural(text, cfg),
  ].filter((f) => !cfg.suppressedRuleIds.includes(f.ruleId));
  return dedupe(raw);
}
