# @wyloc/detector

Local-first secret detection engine for **AI-DLP** — prompt-time Data Loss
Prevention for generative AI.

This is the shared core of the AI-DLP system. It detects credentials in
text *before* that text reaches an LLM. The exact same compiled code is
designed to run inside the browser extension, the VS Code / Cursor
plugin, and the CLI — there is no per-surface fork.

## Design constraints

- **Zero runtime dependencies.** Nothing in `src/` (except `cli.ts`)
  imports a Node or DOM API. This is enforced: `npm run typecheck`
  compiles the library with no `node`/`dom` libs, so an accidental
  `import "node:fs"` into the core fails the build.
- **Pure and synchronous.** `scan()` is a pure function. It is fast
  enough to run on a paste/submit event without debouncing for
  prompt-sized input.
- **Metadata-only by construction.** The only export that produces a
  centralizable record is `buildIncidents()`, and its return type has no
  field that can hold prompt text or a secret value.

## Install & build

```bash
npm install
npm test            # compile patterns + run fixture + unit suite (518 checks)
npm run build       # compile patterns, then to dist/ (library + CLI)
npm run typecheck   # verify the core stays Node-free
```

## Library API

```ts
import { scan, redact, buildIncidents } from "@wyloc/detector";

const result = scan(promptText);
// result.findings  -> Finding[]   (type, span, confidence, environment)
// result.decision  -> { action: "allow" | "warn" | "block", summary }

if (result.decision.action === "block") {
  // surface the block UI
}

// One-click "redact" action for the developer UI:
const safe = redact(promptText, result.findings);

// Metadata-only incident records (safe to send to the control plane):
const incidents = buildIncidents(
  result.findings,
  result.decision.perFinding,
  "browser",
);
```

`scan()` accepts an optional partial config (entropy thresholds,
allowlist additions, suppressed rule IDs) — see `DetectorConfig`.

## CLI

```bash
echo "AKIA..." | npm run scan          # via tsx, no build needed
node dist/cli.js path/to/file.env      # after npm run build
node dist/cli.js --json path/to/file   # machine-readable, value-free
```

Exit codes: `0` clean, `1` warn, `2` block — usable as a pre-commit or
CI guard.

## Detection layers

Findings come from five layers, applied in order (plan §5):

1. **Known patterns** — 83 vendor/format patterns from the JSON pattern
   engine, evaluated by tier (see **Pattern coverage** below). Highest
   precision; the only layer the policy engine will `block` on.
2. **Entropy** — Shannon entropy over secret-shaped tokens. Hashes,
   UUIDs, and identifier-shaped tokens are excluded. Emits `low`/`medium`
   only — entropy never blocks.
3. **Structural** — `KEY=value`, `export SECRET=`, `.env` blocks,
   service-account JSON.
4. **Context** — proximity to keywords (`password`, `token`, `secret`,
   …) raises confidence; it also infers `prod` vs `dev`.
5. **Allowlist** — `localhost`, `example`, placeholder values, plus any
   org/user additions, suppress matches.

## Policy

`WARN` by default. `BLOCK` only when **all** hold: high confidence, a
block-eligible vendor rule, and environment is not `dev`. A wrong block
loses a user; a wrong warn is recoverable. The bar is asymmetric on
purpose (plan §6).

## Pattern coverage

**83 patterns** compiled from JSON definitions, across three tiers. Each
tier is a distinct evaluation strategy with a different false-positive
profile:

### Tier 1 — prefixed (70)

Anchored on a distinctive vendor prefix/structure; a regex match alone is
near-zero-false-positive, so these fire on shape with no context required.

| Group | Vendors |
|---|---|
| Cloud / infra | AWS (access key id, secret-key assignment, Bedrock), Azure storage key, GCP API key, DigitalOcean (access / PAT / refresh), Cloudflare origin-CA, Heroku, Fly.io, Doppler, Databricks, Dynatrace, HashiCorp TF, Pulumi, Vault (batch / service), Artifactory (api / reference) |
| Source control / CI | GitHub (classic + fine-grained), GitLab (11 token types) |
| Comms / collab | Slack (bot + app), Atlassian, Linear, Notion |
| Payments | Stripe (sk/rk × live/test), Square |
| AI / ML | OpenAI, Anthropic, Hugging Face (user + org) |
| SaaS / dev tools | SendGrid, Shopify (4), npm, PyPI, Postman, PlanetScale (3), New Relic (3), Sentry (org + user), Grafana (3), Twilio, Airtable PAT |
| Generic format | OAuth bearer |

### Tier 2 — structural (7)

A recognizable shape rather than a fixed prefix; an optional named
`structuralValidator` hook can reject shapes that match the regex but fail
a deeper check. JWT, PEM private key, database URL with embedded
credentials, GCP service-account JSON.

Structural PII (swap-and-rehydrate, never block — the model never needs the
real value), all using the validator hook:

| Pattern | Gate | Notes |
|---|---|---|
| `pii.credit_card` | **Luhn** checksum + card-network prefix | Visa/Mastercard/Amex/Discover, with optional spaces/dashes. A card-shaped number that fails Luhn (order/tracking id) is rejected. |
| `pii.ssn_dashed` | SSN validity (area ≠ 000/666/900-999, group ≠ 00, serial ≠ 0000) | Dashed/spaced `AAA-GG-SSSS` shape — distinctive enough to fire without context. |
| `pii.ssn_context` | required SSN/social-security keyword in-regex + validity | A bare 9-digit run only matches when labelled (`ssn`, `social security…`); without context it never fires. |

### Tier 3 — generic high-entropy, context-gated (6)

Prefixless shapes (bare hex / base64 / structured blobs) that appear
constantly in innocent text. These fire **only** when a `requiredContext`
keyword sits within the context window, the value clears an
`entropyThreshold`, and it survives the hash/UUID and char-mix guards. The
gate is what protects the false-positive rate.

| Pattern | Gate keywords | Notes |
|---|---|---|
| AWS secret access key (contextual) | `aws`, `amazon`, `secret access key`, … | also opens on a nearby `AKIA…` id (contextRegex) |
| Mailchimp | `mailchimp` | `-usNN` datacenter suffix |
| Dropbox long-lived | `dropbox` | `AAAAAAAAAA` marker |
| Dropbox short-lived | `dropbox` | `sl.` prefix |
| Okta | `okta` | `00` prefix, entropy ≥ 4 |
| Cohere | `co_api_key`, `cohere_api_key` | assignment-only gate (bare "cohere" excluded — common English word) |

## Tuning

`test/fixtures/negative.ts` is the file that matters most — it is the
false-positive trap set. Adding a vendor pattern is cheap; adding a
false positive is expensive. When you change a pattern or threshold,
`npm test` lists exactly which fixture moved.

## Layout

```
src/
  index.ts            public entry — scan(), scanToIncidents()
  types.ts            the shared contract (no deps)
  config.ts           defaults, context keywords, allowlist
  scanner.ts          orchestrates layers 1-5, dedups overlaps
  policy.ts           warn/block/allow decision engine
  redact.ts           redaction + masking helpers
  incident.ts         metadata-only incident construction
  cli.ts              CLI shell (the only Node-coupled file)
  patterns/
    definitions/*.json      Layer 1 patterns, declared as JSON (source of truth)
    schema.ts               authoring + runtime pattern types (3 tiers)
    validators.ts           tier_2 structural-validation hook registry
    compiled.generated.ts   build-time-compiled pattern table (scanner consumes)
  layers/entropy.ts   Layer 2 entropy + token heuristics
  layers/structural.ts Layer 3 assignment detection
  layers/context.ts   Layers 4-5 context gating + allowlist
scripts/
  compile-patterns.ts compiles definitions/*.json -> compiled.generated.ts
                      (validates + fails the build on malformed/unsafe defs)
test/
  run.ts              dependency-free test runner (also validates each
                      definition's inline fixtures)
  fixtures/           positive (must fire) + negative (must not)
```

## Adding a pattern

Drop a JSON file in `src/patterns/definitions/`, run `npm run compile:patterns`,
and commit it — no core code changes. Each definition declares a `tier`
(tier_1 prefixed / tier_2 structural / tier_3 generic high-entropy) and carries
its own positive + negative fixtures. tier_3 patterns MUST declare
`requiredContext` + `entropyThreshold` (enforced by both the type system and
the compiler). `npm test` runs `--check` to ensure the generated table is in
sync and validates every definition's fixtures.
