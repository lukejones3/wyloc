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
import { SECRET_PATTERNS } from "./patterns/known.js";
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

// --- Layer 1 -----------------------------------------------------------
function runKnownPatterns(text: string, cfg: DetectorConfig): Finding[] {
  const out: Finding[] = [];
  for (const pat of SECRET_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      // When the pattern designates a capture group, the finding's span
      // and value are that group — not the surrounding match context.
      let value: string;
      let start: number;
      if (pat.captureGroup !== undefined && m[pat.captureGroup] !== undefined) {
        value = m[pat.captureGroup] as string;
        start = m.index + m[0].indexOf(value);
      } else {
        value = m[0];
        start = m.index;
      }
      const end = start + value.length;
      if (isAllowlisted(text, start, end, value, cfg.allowlist)) continue;

      let confidence = pat.baseConfidence;
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
        ruleId: pat.ruleId,
      });
      // Guard against zero-width matches.
      if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;
    }
  }
  return out;
}

// --- Layer 1b: AWS secret access key (context-gated) -------------------
//
// An AWS secret access key is 40 base64 chars with NO fixed prefix, so in
// isolation it is indistinguishable from a hash, a random token, or
// base64 data — flagging every 40-char blob would wreck the false-positive
// rate. This fires ONLY when AWS-specific context sits within the window
// (an AKIA/ASIA access key id — secret keys are almost always pasted with
// their id — or the word "aws"/"amazon", or a "secret access key" phrase)
// AND the candidate actually looks secret-like (mixed charset, real
// entropy, not a hex digest). The precise `aws_secret_access_key=<value>`
// assignment stays in known.ts; this catches the looser real-world paste
// that the prefix pattern misses.
const AWS_SECRET_KEY_RE =
  /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

const AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/;

function hasAwsContext(
  text: string,
  start: number,
  end: number,
  radius: number,
): boolean {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const w = text.slice(from, to);
  // An access key id beside the candidate is the strongest signal.
  if (AWS_ACCESS_KEY_ID_RE.test(w)) return true;
  const lw = w.toLowerCase();
  return (
    lw.includes("aws") ||
    lw.includes("amazon") ||
    lw.includes("secret access key") ||
    lw.includes("secret_access_key") ||
    lw.includes("secretaccesskey")
  );
}

function runAwsSecretKey(text: string, cfg: DetectorConfig): Finding[] {
  const out: Finding[] = [];
  AWS_SECRET_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AWS_SECRET_KEY_RE.exec(text)) !== null) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    // Guard against zero-width matches (defensive — this pattern can't).
    if (m.index === AWS_SECRET_KEY_RE.lastIndex) AWS_SECRET_KEY_RE.lastIndex++;

    // Reject hashes/UUIDs and single-character-class blobs, and require the
    // entropy of a real key. Mirrors the entropy layer's own guards.
    if (looksLikeHashOrUuid(value)) continue;
    if (!hasSecretLikeCharMix(value)) continue;
    if (shannonEntropy(value) < 3.5) continue;
    // The gate: only emit when AWS context is nearby.
    if (!hasAwsContext(text, start, end, cfg.contextWindow)) continue;
    if (isAllowlisted(text, start, end, value, cfg.allowlist)) continue;

    out.push({
      layer: "known_pattern",
      type: "aws_secret_key",
      confidence: "high",
      start,
      end,
      value,
      environment: inferEnvironment(text, start, end, cfg.contextWindow),
      reason:
        "Looks like an AWS secret access key (40-char key with AWS context nearby).",
      ruleId: "aws.secret_access_key_contextual",
    });
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
    ...runKnownPatterns(text, cfg),
    ...runAwsSecretKey(text, cfg),
    ...runEntropy(text, cfg),
    ...runStructural(text, cfg),
  ].filter((f) => !cfg.suppressedRuleIds.includes(f.ruleId));
  return dedupe(raw);
}
