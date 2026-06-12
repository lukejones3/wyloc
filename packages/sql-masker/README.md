# @wyloc/sql-masker

AST-based, **semantic-preserving** SQL identifier masking for prompt-time DLP.
Mask proprietary tables/schemas/columns out of a SQL query before it is sent to
an LLM, while preserving query-local structure (CTEs, aliases) so the model
still gives good optimization advice — then rehydrate its response in-session.

Built on the empirical finding (see `experiments/sql-masking/`) that
semantic-preserving masks keep optimization quality while opaque tokens degrade
the model's business-logic reasoning.

## Why a Python sidecar

Masking SQL with regex corrupts queries. This package parses a real AST with
[sqlglot](https://github.com/tobymao/sqlglot) via a **persistent Python worker**
(`python/worker.py`), chosen over `node-sql-parser` after a spike in which
node-sql-parser **failed to parse our own primary fixture** while sqlglot parsed
it and resolved the physical-table-vs-CTE distinction via its scope analysis.
sqlglot is also first-class on Snowflake/BigQuery — the real market.

The parser lives behind the `SqlParser` seam (`src/parser/types.ts`); the masking
engine, policy, session map, and rehydration are pure TypeScript. A future
JS/WASM parser could implement the same seam for the browser without touching the
engine. Tradeoff accepted for v1: a Python3 runtime dependency, and masked SQL is
**AST-regenerated** (normalized formatting) rather than format-preserving.

## Setup

```bash
npm run setup:python      # pip install -r python/requirements.txt  (sqlglot)
npm test                  # spawns one worker, runs phase-2 + phase-3 suites
```

## Usage

```ts
import { SqlMasker } from "@wyloc/sql-masker";

const masker = SqlMasker.create({ dialect: "postgres" }); // reuse → warm worker
const { masked, session } = await masker.mask(sql);

const llmReply = await callModel(masked);          // send masked SQL out
const real = masker.rehydrate(llmReply, session);  // reverse known tokens

masker.close();
```

## What it does

- **Physical tables / schemas** → masked, preserving recognizable shape and a
  deterministic hash: `mart_ghost_job_index → mart_<hash>`,
  `dim_store_locations → dim_locations_<hash>`, `job_postings → postings_<hash>`.
- **CTE names + table/derived aliases** → passed through unchanged, but tracked
  so every reference stays consistent (no regex corruption).
- **Columns** → only masked when proprietary (explicit config or concept-token
  auto-detect); generic vocab (`id`, `status`, `created_at`…) is left alone.
  Masked columns keep their type suffix: `ghost_probability → <hash>_probability`.
- **Concept-echo aliases** → a query-local alias whose name derives from a masked
  concept (mask `ghost_probability`, alias `median_ghost`) is itself masked,
  consistently across all references. This was a real leak found in validation.
- **Literal/value scrubbing** (separate AST pass, via `@wyloc/detector`) → scrubs
  sensitive *values* in string literals: an org blocklist (e.g. a federal-staffing
  company list) and PII patterns (email/SSN) are redacted, and secrets the
  detector finds (API keys, DB URLs) are swapped for structural mocks. Operates on
  literal values only, so it can't corrupt SQL structure. Off via `scrubLiterals`.
- **Comments** → stripped (an uncontrolled leak channel; also found in testing).
- **Session map** → RAM-only, bidirectional, never serialized or logged.
- **Rehydration** → reverses only tokens it created; passes through identifiers
  the model invented (index names, new columns) without choking.

Masking is **deterministic** within a session (same real name → same mask). Pass
`sessionSalt` (random per session) for cross-session unlinkability.

## Config (the future `wyloc.json` policy seam)

`MaskerConfig` controls which identifier classes are masked, the prefix/entity/
suffix vocabularies that shape masks and decide proprietary-ness, explicit
proprietary-column rules, dialect, hashing, and comment stripping. See
`src/config.ts` for every knob and its default.

## Out of scope (later phases — not built here)

- **Gateway integration** — wiring this into `@wyloc/gateway`'s request path.
- **Dynamic / string-built SQL** (f-strings) — v1 targets clean, parseable SQL.

## Layout

```
src/
  engine.ts        SqlMasker — orchestration + policy application
  config.ts        MaskerConfig + defaults (the policy seam)
  mask.ts          mask-name generation + concept-token derivation
  literals.ts      literal/value scrubbing pass (blocklist / PII / detector secrets)
  session.ts       RAM-only bidirectional real<->mask map
  rehydrate.ts     reverse known tokens + values, pass through unknowns
  hash.ts          deterministic identifier-safe short hash
  parser/          SqlParser seam + SqlglotWorker (Python sidecar)
python/worker.py   persistent sqlglot JSON-RPC worker
test/              phase-2 (masking) + phase-3 (rehydration) suites
```
