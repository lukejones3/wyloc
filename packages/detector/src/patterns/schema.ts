/**
 * Declarative pattern schema for the detector's pattern engine.
 *
 * Patterns are authored as JSON definitions (src/patterns/definitions/*.json)
 * and compiled at BUILD TIME into an efficient in-memory table
 * (compiled.generated.ts) that the scanner consumes. The browser runtime
 * never parses these JSON files — it only ever sees the pre-compiled table.
 *
 * This module is PURE (no DOM, no Node) so it is safe to ship: it defines
 * (a) the authoring shape — `PatternDefinition`, the discriminated union the
 *     compiler validates raw JSON against, and
 * (b) the runtime shape — `CompiledPattern`, what the scanner consumes.
 *
 * ── The three tiers ────────────────────────────────────────────────────
 *
 *  tier_1  PREFIXED. Anchored on a vendor prefix/marker (SG., shpat_, ghp_,
 *          AKIA…). A regex match alone is near-zero-false-positive, so the
 *          finding is emitted on the regex with no further gating.
 *
 *  tier_2  STRUCTURAL. Matches a recognisable shape (JWT, PEM block, DB URI).
 *          The regex carries most of the precision; an OPTIONAL named
 *          `structuralValidator` hook can reject shapes that match the regex
 *          but fail a deeper structural check.
 *
 *  tier_3  GENERIC HIGH-ENTROPY. A blob with no fixed prefix (e.g. a Twilio
 *          auth token, an AWS secret access key). Matching the shape alone
 *          would wreck the false-positive rate, so a tier_3 pattern MUST
 *          declare `requiredContext` (a hard gate — the pattern does not fire
 *          unless one of these appears nearby) and an `entropyThreshold`. The
 *          types below make it impossible to express a tier_3 pattern without
 *          them — `requiredContext` is a non-empty tuple, so `[]` is a type
 *          error, and the compiler re-checks the same constraint on the raw
 *          JSON so a hand-written definition cannot slip past either.
 *
 *          NOTE: `requiredContext` is deliberately named distinctly from the
 *          global CONTEXT_KEYWORDS (config.ts). The global list only *raises*
 *          confidence on tier_1/tier_2 findings; `requiredContext` is a hard
 *          per-pattern gate. Same shape, opposite force — don't conflate them.
 */

import type { Confidence, SecretType } from "../types.js";

/** The safety tier a pattern is evaluated under. */
export type PatternTier = "tier_1" | "tier_2" | "tier_3";

/**
 * A regex expressed in a JSON-safe way: a source string plus optional flags.
 * The compiler constructs the `RegExp`, enforces the global (`g`) flag the
 * scanner relies on, and fails the build if the source does not compile.
 */
export interface RegexSpec {
  /** Regex source, WITHOUT delimiters. e.g. "\\bghp_[A-Za-z0-9]{36}\\b" */
  source: string;
  /** Extra flags (e.g. "i"). The compiler always ensures "g" is present. */
  flags?: string;
}

/** Inline test fixtures that travel with every definition. */
export interface PatternFixtures {
  /** Strings the pattern MUST match. At least one is required. */
  positive: [string, ...string[]];
  /** Strings the pattern must NOT match. May be empty. */
  negative: string[];
}

/** Fields shared by every pattern definition regardless of tier. */
interface BasePatternDefinition {
  /** Stable rule id, used for suppression + telemetry. e.g. "github.token". */
  id: string;
  /** Human-readable label for the developer UI. */
  displayName: string;
  /** Coarse classification — this is what drives the swap engine's strategy. */
  type: SecretType;
  /** Baseline confidence before contextual adjustment. */
  confidence: Confidence;
  /**
   * If true, the policy engine MAY block on this pattern without extra
   * context. If false, it can only ever warn.
   */
  blockEligible: boolean;
  /** Plain, factual, non-shaming explanation shown to the developer. */
  reason: string;
  /** The detection regex. */
  regex: RegexSpec;
  /**
   * If set, the finding's span and value come from this capture group rather
   * than the whole match. Use when the regex must match surrounding context
   * (e.g. `aws_secret_access_key=`) but only the group is the secret.
   */
  captureGroup?: number;
  /** Inline positive + negative fixtures. Required — see PatternFixtures. */
  fixtures: PatternFixtures;
}

/** tier_1: prefixed. Regex match alone is sufficient. */
export interface Tier1PatternDefinition extends BasePatternDefinition {
  tier: "tier_1";
}

/** tier_2: structural shape, with an optional deeper validation hook. */
export interface Tier2PatternDefinition extends BasePatternDefinition {
  tier: "tier_2";
  /**
   * Optional name of a structural validator from the validator registry
   * (patterns/validators.ts). Receives the matched value and returns false to
   * reject. The compiler fails the build if the named validator is unknown.
   */
  structuralValidator?: string;
}

/** tier_3: generic high-entropy. Context keywords + entropy floor REQUIRED. */
export interface Tier3PatternDefinition extends BasePatternDefinition {
  tier: "tier_3";
  /**
   * Hard gate — at least one MUST appear within the context window for the
   * pattern to fire at all. The non-empty tuple type makes an empty list a
   * compile error; the build-time validator enforces the same on raw JSON.
   * This is the constraint that protects the false-positive rate as the
   * pattern set scales.
   */
  requiredContext: [string, ...string[]];
  /**
   * Optional additional regex signal that also opens the gate (matched, not
   * captured, within the window). e.g. an AWS access key id sitting beside a
   * bare secret access key.
   */
  contextRegex?: RegexSpec;
  /** Minimum Shannon entropy (bits/char) the candidate must clear. */
  entropyThreshold: number;
}

/**
 * The authoring shape. A discriminated union on `tier` — TypeScript will
 * reject a `tier_3` object that omits `contextKeywords`/`entropyThreshold`,
 * and reject `contextKeywords: []`.
 */
export type PatternDefinition =
  | Tier1PatternDefinition
  | Tier2PatternDefinition
  | Tier3PatternDefinition;

/**
 * The runtime shape the scanner consumes. Produced by the compiler from a
 * `PatternDefinition`: regexes are real `RegExp`s, the validator name is
 * resolved to a function, and tier-specific fields are normalised onto one
 * flat record so the scanner can branch on `tier` without re-deriving shape.
 */
export interface CompiledPattern {
  id: string;
  displayName: string;
  type: SecretType;
  tier: PatternTier;
  confidence: Confidence;
  blockEligible: boolean;
  reason: string;
  /** Compiled detection regex (always global). */
  regex: RegExp;
  captureGroup?: number;
  /** tier_2 only: resolved structural validation hook. */
  structuralValidator?: (value: string) => boolean;
  /** tier_3 only: hard-gate keywords (already lowercased by the compiler). */
  requiredContext?: readonly string[];
  /** tier_3 only: optional extra gate regex (non-global). */
  contextRegex?: RegExp;
  /** tier_3 only: minimum entropy. */
  entropyThreshold?: number;
  /**
   * Optional NON-SENSITIVE label propagated to a finding's `maskHint`, used to
   * shape the swap mock (e.g. an org pattern named "Employee ID" →
   * `WYLOC_MOCK_EMPLOYEE_ID_<hash>`). Set by the wyloc.json compiler.
   */
  maskHint?: string;
}
