/**
 * Positive fixtures: inputs that MUST produce at least one finding.
 *
 * The secret values here are syntactically valid-shaped but FAKE —
 * randomly generated to match each vendor's format. They are not, and
 * never have been, live credentials. They exist only to exercise the
 * regexes. Do not "fix" them by inserting real values.
 *
 * `expectType` / `expectAction` assert the detector's classification.
 */

export interface PositiveFixture {
  name: string;
  text: string;
  expectType: string;
  /** Strongest action expected for the scan as a whole. */
  expectAction: "warn" | "block";
}

export const positiveFixtures: PositiveFixture[] = [
  {
    name: "AWS access key ID, bare",
    text: "Here is my key AKIA5XQ2WJ8NPLR3MKVT please debug the upload",
    expectType: "aws_access_key",
    expectAction: "block",
  },
  {
    name: "AWS access key ID, realistic",
    text: "deploy failed with key AKIA2RZ4QF7KJ9XW1MTL in prod",
    expectType: "aws_access_key",
    expectAction: "block",
  },
  {
    name: "AWS secret access key assignment",
    text: 'aws_secret_access_key = "wJ8xK2pQ7nR4tV9sL1mB3cF6dG0hY5uZ8aE2iO4z"',
    expectType: "aws_secret_key",
    expectAction: "block",
  },
  {
    name: "GCP API key",
    text: "const key = 'AIzaSyD3kL9mN2pQ7rS4tU6vW8xY1zA5bC0dEfG'",
    expectType: "gcp_api_key",
    expectAction: "block",
  },
  {
    name: "GitHub classic PAT",
    text: "git remote set-url origin https://ghp_aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4 @github.com/x/y",
    expectType: "github_token",
    expectAction: "block",
  },
  {
    name: "GitHub fine-grained PAT",
    text: "token: github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuV1234",
    expectType: "github_token",
    expectAction: "block",
  },
  {
    name: "Slack bot token",
    text: "SLACK_BOT_TOKEN=xoxb-1234567890-0987654321098-AbCdEfGhIjKlMnOpQrStUvWx",
    expectType: "slack_token",
    expectAction: "block",
  },
  {
    name: "Stripe live secret key",
    text: "stripe.api_key = sk_live_4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh in production config",
    expectType: "stripe_key",
    expectAction: "block",
  },
  {
    name: "Stripe test secret key (warn only)",
    text: "stripe.api_key = sk_test_4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh",
    expectType: "stripe_key",
    expectAction: "warn",
  },
  {
    name: "OpenAI key",
    text: "export OPENAI_API_KEY=sk-proj-aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5a",
    expectType: "openai_key",
    expectAction: "block",
  },
  {
    name: "Anthropic key",
    text: "ANTHROPIC_API_KEY=sk-ant-api03-aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5",
    expectType: "anthropic_key",
    expectAction: "block",
  },
  {
    name: "JWT (warn only)",
    text: "Authorization header has eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHDpoyU1tLFmKgKM5OdHk7vRkPak",
    expectType: "jwt",
    expectAction: "warn",
  },
  {
    name: "Private key PEM header",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...",
    expectType: "private_key",
    expectAction: "block",
  },
  {
    name: "Postgres URL with credentials",
    text: "DATABASE_URL=postgresql://admin:Sup3rS3cr3tP4ss@db.prod.internal:5432/main",
    expectType: "database_url",
    expectAction: "block",
  },
  {
    name: "MongoDB SRV URL with credentials",
    text: "connect mongodb+srv://svc_user:xK9pL2mQ7n@cluster0.ab1cd.mongodb.net/app",
    expectType: "database_url",
    expectAction: "block",
  },
  {
    name: "Structural .env credential assignment",
    text: "# config\nDB_PASSWORD=R4nd0mP4ssw0rdValue99\nPORT=3000",
    expectType: "env_assignment",
    expectAction: "warn",
  },
  {
    name: "GCP service account key file",
    text: '{ "type": "service_account", "project_id": "my-app", "private_key_id": "abc123" }',
    expectType: "gcp_service_account",
    expectAction: "block",
  },
  {
    name: "Entropy hit near context keyword",
    text: "the api secret is qX7vN2pR9mK4tL8wZ1cB6dF3gH0jY5sA and it expired",
    expectType: "high_entropy_string",
    expectAction: "warn",
  },
];
