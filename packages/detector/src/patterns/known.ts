import type { Confidence, SecretType } from "../types.js";

/**
 * A single known-secret pattern. Patterns are intentionally anchored on
 * vendor-specific prefixes/structure so they fire with high precision.
 *
 * `regex` must use the global flag — the scanner relies on `lastIndex`.
 */
export interface SecretPattern {
  ruleId: string;
  type: SecretType;
  /** Baseline confidence before contextual adjustment. */
  baseConfidence: Confidence;
  regex: RegExp;
  /** Shown in the developer UI. Plain, factual, non-shaming. */
  reason: string;
  /**
   * If true, this pattern is precise enough that the policy engine may
   * BLOCK on it without additional context. If false, it can only WARN.
   */
  blockEligible: boolean;
  /**
   * If set, the finding's span and value come from this capture group
   * rather than the whole match. Use when the regex must match
   * surrounding context (e.g. `aws_secret_access_key=`) but only the
   * group is the actual secret.
   */
  captureGroup?: number;
}

/**
 * Layer 1 patterns. Ordered roughly by precision. Vendor formats first,
 * generic structural matches handled separately in the structural layer.
 *
 * Sources: each vendor's published token format. Where a vendor uses a
 * fixed prefix (AKIA, sk-, xoxb-, ghp_, ...) we anchor on it to keep
 * false positives near zero.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // ---- AWS ----------------------------------------------------------
  {
    ruleId: "aws.access_key_id",
    type: "aws_access_key",
    baseConfidence: "high",
    // AKIA (long-term), ASIA (temp), plus less common ABIA/ACCA.
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    reason: "Looks like an AWS access key ID.",
    blockEligible: true,
  },
  {
    ruleId: "aws.secret_access_key",
    type: "aws_secret_key",
    baseConfidence: "medium", // 40-char base64 is ambiguous without context
    regex: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+]{40})['"]?/gi,
    reason: "Looks like an AWS secret access key.",
    blockEligible: true,
    captureGroup: 1,
  },

  // ---- GCP ----------------------------------------------------------
  {
    ruleId: "gcp.api_key",
    type: "gcp_api_key",
    baseConfidence: "high",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    reason: "Looks like a Google Cloud API key.",
    blockEligible: true,
  },
  {
    ruleId: "gcp.service_account_key",
    type: "gcp_service_account",
    baseConfidence: "high",
    // The private_key_id + "type": "service_account" marker.
    regex: /"type"\s*:\s*"service_account"/g,
    reason: "Looks like a GCP service account key file.",
    blockEligible: true,
  },

  // ---- Azure --------------------------------------------------------
  {
    ruleId: "azure.storage_key",
    type: "azure_token",
    baseConfidence: "medium",
    regex: /\bAccountKey=[A-Za-z0-9/+]{86}==/g,
    reason: "Looks like an Azure storage account key.",
    blockEligible: true,
  },

  // ---- GitHub -------------------------------------------------------
  {
    ruleId: "github.token",
    type: "github_token",
    baseConfidence: "high",
    // ghp_ (PAT), gho_ (OAuth), ghu_/ghs_ (app), ghr_ (refresh).
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    reason: "Looks like a GitHub token.",
    blockEligible: true,
  },
  {
    ruleId: "github.fine_grained_pat",
    type: "github_token",
    baseConfidence: "high",
    regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
    reason: "Looks like a GitHub fine-grained personal access token.",
    blockEligible: true,
  },

  // ---- GitLab -------------------------------------------------------
  {
    ruleId: "gitlab.pat",
    type: "gitlab_token",
    baseConfidence: "high",
    regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g,
    reason: "Looks like a GitLab personal access token.",
    blockEligible: true,
  },

  // ---- Slack --------------------------------------------------------
  {
    ruleId: "slack.token",
    type: "slack_token",
    baseConfidence: "high",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    reason: "Looks like a Slack token.",
    blockEligible: true,
  },

  // ---- Stripe -------------------------------------------------------
  {
    ruleId: "stripe.live_secret_key",
    type: "stripe_key",
    baseConfidence: "high",
    regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    reason: "Looks like a live Stripe secret key.",
    blockEligible: true,
  },
  {
    ruleId: "stripe.test_secret_key",
    type: "stripe_key",
    baseConfidence: "medium",
    regex: /\bsk_test_[A-Za-z0-9]{20,}\b/g,
    reason: "Looks like a test-mode Stripe secret key.",
    blockEligible: false, // test key — warn, don't block
  },

  // ---- OpenAI -------------------------------------------------------
  {
    ruleId: "openai.api_key",
    type: "openai_key",
    baseConfidence: "high",
    // Classic sk- and project-scoped sk-proj- keys. Negative lookahead
    // excludes sk-ant- so Anthropic keys classify under their own rule.
    regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9\-_]{20,}\b/g,
    reason: "Looks like an OpenAI API key.",
    blockEligible: true,
  },

  // ---- Anthropic ----------------------------------------------------
  {
    ruleId: "anthropic.api_key",
    type: "anthropic_key",
    baseConfidence: "high",
    regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    reason: "Looks like an Anthropic API key.",
    blockEligible: true,
  },

  // ---- JWT ----------------------------------------------------------
  {
    ruleId: "jwt.token",
    type: "jwt",
    baseConfidence: "medium",
    // header.payload.signature — each segment base64url.
    regex: /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g,
    reason: "Looks like a JSON Web Token (JWT).",
    blockEligible: false, // JWTs are often short-lived / non-sensitive
  },

  // ---- OAuth bearer -------------------------------------------------
  {
    ruleId: "oauth.bearer",
    type: "oauth_bearer",
    baseConfidence: "medium",
    regex: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
    reason: "Looks like an OAuth bearer token.",
    blockEligible: false,
  },

  // ---- Private keys -------------------------------------------------
  {
    ruleId: "private_key.pem",
    type: "private_key",
    baseConfidence: "high",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    reason: "Looks like a PEM-encoded private key.",
    blockEligible: true,
  },

  // ---- Database URLs ------------------------------------------------
  {
    ruleId: "database.url_with_credentials",
    type: "database_url",
    baseConfidence: "high",
    // scheme://user:password@host — only flags when a password is present.
    regex:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
    reason: "Looks like a database connection string with embedded credentials.",
    blockEligible: true,
  },
];
