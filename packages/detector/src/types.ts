/**
 * Core type definitions for the AI-DLP detection engine.
 *
 * This module is the shared contract consumed by the browser extension,
 * the IDE plugin, and the CLI. It must remain free of any DOM or Node
 * dependencies so the same compiled code runs everywhere.
 */

/** Which detection layer produced a finding. Mirrors the plan's Section 5. */
export type DetectionLayer =
  | "known_pattern" // Layer 1: vendor secret formats (AWS, Stripe, ...)
  | "entropy" // Layer 2: high-entropy random strings
  | "structural" // Layer 3: .env / KEY=value / export blocks
  | "context"; // Layer 4: contextual gate (not a standalone source)

/** Confidence that a finding is a real, sensitive secret. */
export type Confidence = "low" | "medium" | "high";

/**
 * Coarse classification of the matched secret. This is the ONLY part of a
 * finding that may ever be centralized — never the value, never the text.
 * See plan Section 9 (Metadata-Only logging).
 */
export type SecretType =
  // Cloud platforms
  | "aws_access_key"
  | "aws_secret_key"
  | "aws_bedrock_key"
  | "gcp_api_key"
  | "gcp_service_account"
  | "azure_token"
  | "digitalocean_token"
  | "heroku_key"
  | "flyio_token"
  | "cloudflare_key"
  | "doppler_token"
  | "databricks_token"
  | "vault_token"
  | "pulumi_token"
  | "hashicorp_token"
  | "dynatrace_token"
  // Source control / CI
  | "github_token"
  | "gitlab_token"
  // Communication / collaboration
  | "slack_token"
  | "atlassian_token"
  | "linear_token"
  | "notion_token"
  | "okta_token"
  // Payments
  | "stripe_key"
  | "square_token"
  // AI / ML
  | "openai_key"
  | "anthropic_key"
  | "huggingface_token"
  | "cohere_token"
  // SaaS / developer tools
  | "sendgrid_key"
  | "shopify_token"
  | "npm_token"
  | "pypi_token"
  | "postman_token"
  | "planetscale_token"
  | "new_relic_key"
  | "sentry_token"
  | "grafana_token"
  | "twilio_key"
  | "artifactory_key"
  | "mailchimp_token"
  | "dropbox_token"
  | "airtable_token"
  // Standard formats
  | "jwt"
  | "oauth_bearer"
  | "private_key"
  | "database_url"
  // Generic / structural
  | "generic_api_key"
  | "high_entropy_string"
  | "env_assignment"
  // Structural PII (swap-and-rehydrate; the model never needs the real value)
  | "credit_card"
  | "ssn";

/** Environment inferred from surrounding context, used by the policy engine. */
export type Environment = "prod" | "dev" | "unknown";

/** A single detected secret within the scanned text. */
export interface Finding {
  /** Layer that produced this finding. */
  layer: DetectionLayer;
  /** Coarse type — safe to centralize. */
  type: SecretType;
  /** Confidence the match is a genuine secret. */
  confidence: Confidence;
  /** Inclusive start index into the original text. */
  start: number;
  /** Exclusive end index into the original text. */
  end: number;
  /**
   * The matched substring. Stays LOCAL ONLY. Used to render inline
   * highlights and redaction previews. Must never be logged or sent
   * to the control plane.
   */
  value: string;
  /** Inferred environment, when context allows. */
  environment: Environment;
  /** Human-readable, non-shaming explanation for the developer UI. */
  reason: string;
  /** Stable rule identifier, for suppression and telemetry counts. */
  ruleId: string;
}

/** Policy action for a single finding or for the scan as a whole. */
export type Action = "allow" | "warn" | "block";

/** Result of running the policy engine over a set of findings. */
export interface PolicyDecision {
  /** The strongest action across all findings. */
  action: Action;
  /** Per-finding actions, index-aligned with the input findings array. */
  perFinding: Action[];
  /** Short summary for UI surfacing, e.g. "1 production secret blocked". */
  summary: string;
}

/**
 * Metadata-only incident record. This is the exact shape that may leave
 * the machine. By construction it contains no prompt text and no value.
 */
export interface IncidentMetadata {
  timestamp: string; // ISO 8601
  tool: "browser" | "ide" | "cli";
  secretType: SecretType;
  layer: DetectionLayer;
  confidence: Confidence;
  environment: Environment;
  action: Action;
  ruleId: string;
}

/** Tuning knobs for a scan. All optional; defaults live in `defaultConfig`. */
export interface DetectorConfig {
  /** Minimum Shannon entropy (bits/char) for Layer 2 to consider a token. */
  entropyThreshold: number;
  /** Minimum token length for entropy scoring. */
  entropyMinLength: number;
  /**
   * If true, entropy-only findings with no nearby context keyword are
   * dropped entirely rather than emitted as low-confidence warnings.
   */
  requireContextForEntropy: boolean;
  /** Rule IDs the user/org has explicitly suppressed. */
  suppressedRuleIds: string[];
  /**
   * Substrings that, if they overlap a candidate, suppress it.
   * Defaults cover localhost / example / test values.
   */
  allowlist: string[];
  /** Window (chars) on each side of a match used for context gating. */
  contextWindow: number;
}

/** Full result of `scan()`. */
export interface ScanResult {
  findings: Finding[];
  decision: PolicyDecision;
  /** Original text length — useful for UI without re-sending the text. */
  textLength: number;
}
