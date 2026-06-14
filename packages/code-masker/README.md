# @wyloc/code-masker

AST-based, semantic-preserving **TypeScript/JavaScript** identifier masking for
prompt-time DLP. The code-structure analog of [`@wyloc/sql-masker`](../sql-masker):
**mask proprietary identity, preserve meaning**, so an LLM can still understand and
help with the code — then rehydrate its response in-session.

Standalone and in-process: the TypeScript Compiler API parses and classifies
(no sidecar, unlike the SQL masker's Python worker). Not yet wired into the gateway.

## What it does

| Bucket | Behavior |
|---|---|
| **1 — always mask** | Internally-defined classes / functions / interfaces / types / enums / namespaces → kind-preserving masks (`BillingReconciler → Class_<hash>`). Relative imports + their path strings. Internal URLs / hosts / private IPs / home-dir paths in string literals. Hardcoded secrets → swapped via `@wyloc/detector`. |
| **2 — gated (off by default)** | Fuzzier in-string references (codenames, queue/topic names) via org-supplied `bucket2Patterns` / `bucket2Substrings`. Conservative to avoid false positives. |
| **3 — never touched** | Language keywords/syntax, **anything imported from an external/third-party package** (React, lodash, Node built-ins — resolved by import origin, the make-or-break rule), generic local variables, and the business logic / control flow itself. |

**Comments are stripped wholesale** (both `//` and `/* */`) — a leak channel with
negligible value to the model for code-help tasks.

Masks are **deterministic** (same identifier → same mask within a session) and
applied **consistently across every reference** via the AST, so the regenerated
code stays valid. Output is regenerated from the AST (reformatting is accepted,
like the SQL masker) to guarantee valid TS over fragile span-surgery.

## Usage

```ts
import { CodeMasker } from "@wyloc/code-masker";

const masker = CodeMasker.create(/* config overrides */);
const { masked, session } = masker.mask(sourceCode, "file.ts");
// send `masked` to the LLM; keep `session` (RAM-only) for rehydration.

const restored = masker.rehydrate(llmResponse, session);
// reverses ONLY the tokens we created; identifiers the model invented pass through.
```

The `session` is an in-memory, bidirectional real↔mask map. **RAM-only invariant:**
never serialized, never logged.

## Classification

Built on the **TypeScript Compiler API** (chosen in Phase 1 over tree-sitter
because import/scope resolution is exactly what internal-vs-external classification
needs, and it runs in-process with no sidecar). Origin is decided from the import's
**module specifier**, not the declaration file path — so symlinked workspace
packages aren't mislabeled:

- `./x`, `../x` → **internal** (masked)
- `node:*`, bare specifiers (`react`, `lodash`) → **external** (never masked)
- bare specifiers matching `internalScopes` (e.g. `@acme/*`) → internal (config seam)

## Config (the `wyloc.json` policy seam)

`resolveConfig(input)` ships sensible defaults; every knob deciding *what* is
proprietary and *how* a mask is shaped lives in `CodeMaskerConfig`. Notable knobs:

- `maskMembers` — **default `false`**. Member (method/property) masking is correct
  on well-typed code, but accesses on `any`-typed values can't be resolved by the
  checker, which would leak the name at those sites (partial masking). Enable on
  well-typed codebases.
- `internalScopes`, `internalDomains`, `internalTlds`, `internalPathPatterns` —
  broaden what counts as internal infrastructure.
- `maskBucket2`, `bucket2Patterns`, `bucket2Substrings` — opt-in fuzzy string masking.
- `scrubSecrets` — reuse `@wyloc/detector` (never rebuilt).

## Status

- **Phase 1** — parser decision (TS Compiler API). ✅
- **Phase 2** — masking engine + classification + comment stripping + tests. ✅
- **Phase 3** — rehydration (reverse our tokens, pass through invented names) +
  round-trip tests + template-literal `${}` masking. ✅
- **Next** — gateway integration (deliberately out of scope so far).

## Known limitations

- `maskMembers` is opt-in/conservative (see above); object-literal keys that resolve
  to a masked member may not always rename.
- TS/JS only by design.

## Test

```
npm test   # real-shaped fixtures incl. a real file from this repo; negative fixtures
```
