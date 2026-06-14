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

- `maskMembers` — **default `false`** (opt-in). When on, member (method/property)
  masking is **type-completeness gated**: a member is masked only if *every* access
  site of its name is confidently resolvable (fully-typed property/element access).
  If any site is unresolvable — an `any`-typed access, a computed string access the
  checker can't link, or an object-literal key contextually typed to the host — the
  member is left **completely untouched**. Masking is therefore all-or-nothing per
  member: never partial, so it never leaks the name or breaks the code. On a real
  mixed codebase (this repo) ~63% of candidate members are fully resolvable and
  masked; the rest are safely skipped. (Fully-dynamic `obj[expr]` access doesn't
  name the member textually and is a documented residual.)
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

- `maskMembers` is opt-in and conservative by design (see above): it skips a member
  rather than risk partial masking, so coverage trades off against safety. Members
  reached only through fully-typed sites are masked; the rest are skipped intact.
- Fully-dynamic member access (`obj[expr]` with a non-literal key) can't be
  attributed to a member by name; it neither blocks nor is rewritten.
- TS/JS only by design.

## Test

```
npm test   # real-shaped fixtures incl. a real file from this repo; negative fixtures
```
