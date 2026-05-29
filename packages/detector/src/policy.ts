/**
 * Policy engine — plan Section 6.
 *
 * Non-negotiable defaults:
 *   - WARN by default.
 *   - BLOCK only on high-confidence production secrets.
 *
 * Rationale: false positives that BLOCK destroy adoption. A warn is
 * recoverable (the developer reads it and decides); a wrong block is
 * a developer who disables the tool. So the bar for BLOCK is high and
 * narrow, and everything uncertain degrades to WARN, never the reverse.
 */

import type {
  Action,
  Finding,
  PolicyDecision,
  SecretType,
} from "./types.js";
import { COMPILED_PATTERNS } from "./patterns/compiled.generated.js";

/** Rule IDs that are precise enough to BLOCK on. Built from the pattern set. */
const BLOCK_ELIGIBLE_RULES: ReadonlySet<string> = new Set(
  COMPILED_PATTERNS.filter((p) => p.blockEligible).map((p) => p.id),
);

/** Severity ordering so we can take the strongest action across findings. */
const ACTION_RANK: Record<Action, number> = {
  allow: 0,
  warn: 1,
  block: 2,
};

function strongest(a: Action, b: Action): Action {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/**
 * Decide the action for a single finding.
 *
 * BLOCK requires ALL of:
 *   - high confidence, AND
 *   - a block-eligible rule (vendor pattern precise enough), AND
 *   - environment is NOT dev (prod or unknown — we don't block on a
 *     key explicitly sitting in a dev/test context).
 *
 * Everything else that is a real finding becomes WARN. Nothing here
 * ever returns `allow` — allow is the absence of a finding, or an
 * explicit user suppression handled upstream.
 */
export function decideForFinding(f: Finding): Action {
  const highConfidence = f.confidence === "high";
  const blockEligibleRule = BLOCK_ELIGIBLE_RULES.has(f.ruleId);
  const notDev = f.environment !== "dev";

  if (highConfidence && blockEligibleRule && notDev) {
    return "block";
  }
  return "warn";
}

/** Human-readable secret-type labels for the UI summary. */
const TYPE_LABELS: Record<SecretType, string> = {
  // Cloud platforms
  aws_access_key: "AWS access key",
  aws_secret_key: "AWS secret key",
  aws_bedrock_key: "AWS Bedrock API key",
  gcp_api_key: "GCP API key",
  gcp_service_account: "GCP service account key",
  azure_token: "Azure token",
  digitalocean_token: "DigitalOcean token",
  heroku_key: "Heroku API key",
  flyio_token: "Fly.io token",
  cloudflare_key: "Cloudflare key",
  doppler_token: "Doppler token",
  databricks_token: "Databricks token",
  vault_token: "Vault token",
  pulumi_token: "Pulumi token",
  hashicorp_token: "HashiCorp token",
  dynatrace_token: "Dynatrace token",
  // Source control / CI
  github_token: "GitHub token",
  gitlab_token: "GitLab token",
  // Communication / collaboration
  slack_token: "Slack token",
  atlassian_token: "Atlassian token",
  linear_token: "Linear token",
  notion_token: "Notion token",
  // Payments
  stripe_key: "Stripe key",
  square_token: "Square token",
  // AI / ML
  openai_key: "OpenAI key",
  anthropic_key: "Anthropic key",
  huggingface_token: "Hugging Face token",
  // SaaS / developer tools
  sendgrid_key: "SendGrid key",
  shopify_token: "Shopify token",
  npm_token: "npm token",
  pypi_token: "PyPI token",
  postman_token: "Postman token",
  planetscale_token: "PlanetScale token",
  new_relic_key: "New Relic key",
  sentry_token: "Sentry token",
  grafana_token: "Grafana token",
  twilio_key: "Twilio key",
  artifactory_key: "Artifactory key",
  // Standard formats
  jwt: "JWT",
  oauth_bearer: "OAuth bearer token",
  private_key: "private key",
  database_url: "database URL",
  // Generic / structural
  generic_api_key: "API key",
  high_entropy_string: "high-entropy string",
  env_assignment: "credential assignment",
};

function summarize(findings: Finding[], perFinding: Action[]): string {
  if (findings.length === 0) return "No secrets detected.";

  const blocked = perFinding.filter((a) => a === "block").length;
  const warned = perFinding.filter((a) => a === "warn").length;

  // Name the single most severe finding for a concrete message.
  let lead: Finding | undefined;
  let leadRank = -1;
  findings.forEach((f, i) => {
    const a: Action = perFinding[i] ?? "warn";
    const r = ACTION_RANK[a];
    if (r > leadRank) {
      leadRank = r;
      lead = f;
    }
  });
  const leadLabel = lead ? TYPE_LABELS[lead.type] : "secret";

  if (blocked > 0) {
    const extra = blocked + warned - 1;
    return extra > 0
      ? `Blocked: ${leadLabel} detected (+${extra} more).`
      : `Blocked: ${leadLabel} detected.`;
  }
  if (warned > 0) {
    return warned === 1
      ? `Warning: possible ${leadLabel} detected.`
      : `Warning: ${warned} possible secrets detected.`;
  }
  return "No secrets detected.";
}

/** Run the policy engine over a full set of findings. */
export function decide(findings: Finding[]): PolicyDecision {
  const perFinding = findings.map(decideForFinding);
  const action = perFinding.reduce<Action>(
    (acc, a) => strongest(acc, a),
    "allow",
  );
  return {
    action,
    perFinding,
    summary: summarize(findings, perFinding),
  };
}
