# @ai-dlp/detector

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
npm test            # run fixture + unit suite (85 checks)
npm run build       # compile to dist/ (library + CLI)
npm run typecheck   # verify the core stays Node-free
```

## Library API

```ts
import { scan, redact, buildIncidents } from "@ai-dlp/detector";

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

1. **Known patterns** — vendor-anchored regexes (AWS, GCP, Azure,
   GitHub, GitLab, Slack, Stripe, OpenAI, Anthropic, JWT, OAuth, PEM
   keys, DB URLs). Highest precision; the only layer the policy engine
   will `block` on.
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
  patterns/known.ts   Layer 1 vendor patterns
  layers/entropy.ts   Layer 2 entropy + token heuristics
  layers/structural.ts Layer 3 assignment detection
  layers/context.ts   Layers 4-5 context gating + allowlist
test/
  run.ts              dependency-free test runner
  fixtures/           positive (must fire) + negative (must not)
```
