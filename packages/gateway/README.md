# @wyloc/gateway

A local proxy that sits between a base-URL-configurable LLM client and the
upstream API. It detects secrets in outbound prompts and swaps them for
`WYLOC_MOCK_` placeholders **before they leave the machine**, then rehydrates
the real values inline in the streamed response — the same protection as the
Wyloc browser extension, reusing the same [`@wyloc/detector`](../detector) engine.

**Four wire formats, one core.** The masking/detector/SQL/rehydration engine is
wire-format-agnostic; a thin per-provider adapter (`src/adapters/`) handles each
format. Routing is by endpoint:

| Client | Point it with | Endpoint | Forwarded to |
| --- | --- | --- | --- |
| **Claude Code** | `ANTHROPIC_BASE_URL` | `/v1/messages` | `api.anthropic.com` |
| **Codex CLI** | `~/.codex/config.toml` `openai_base_url` | `/v1/responses` | `api.openai.com` |
| **OpenAI Chat clients** | `OPENAI_BASE_URL` | `/v1/chat/completions` | `api.openai.com` |
| **Gemini CLI** | `GEMINI_BASE_URL` | `/v1beta/models/*:generateContent` | `generativelanguage.googleapis.com` |

The OpenAI Chat endpoint covers the broader OpenAI-compatible ecosystem —
**Aider, Goose, OpenCode, Continue, Cline, Roo Code, Kilo Code** all speak Chat
Completions and are masked as-is once pointed at the gateway. See
[**SUPPORTED_TOOLS.md**](./SUPPORTED_TOOLS.md) for the per-tool routing,
wire-format, file-read, and `wyloc setup` matrix (the single source of truth for
what Wyloc covers).

Auth is **relayed, never replaced** — `x-api-key` (Anthropic),
`Authorization: Bearer` (OpenAI), and `x-goog-api-key` / `?key=` (Gemini) each
pass straight through to the matching upstream, and `Host` is set per-provider.

```
 claude / codex ─►  *_BASE_URL=http://127.0.0.1:8787
                     │
                     ▼
            ┌──────────────────┐   real→mock swap (user text only)
            │  @wyloc/gateway  │ ──────────────────►  api.anthropic.com / api.openai.com
            │   adapter seam   │ ◄──────────────────  (your real key, relayed)
            └──────────────────┘   mock→real rehydrate (SSE stream)
```

The gateway never sees a Wyloc account — it only relays your own credentials.

## Status

- **Phase 1 — pass-through proxy** ✅. Forwards `/v1/messages` and
  `/v1/messages/count_tokens` with auth/headers intact and streams the SSE
  response back unchanged.
- **Phase 2 — request-path real→mock swap** ✅. Scans user text (text
  blocks + `system`) and replaces secrets with `WYLOC_MOCK_` placeholders
  before forwarding. Tool blocks and structure are untouched.
  `WYLOC_ON_DETECT=block` rejects instead of swapping.
- **Phase 3 — streaming mock→real rehydrate + system-prompt injection** ✅
  (this build). The SSE response is rewritten inline — `WYLOC_MOCK_` tokens
  in the assistant's visible text (`text_delta` only) are rehydrated back
  to the real values, with token-boundary buffering so a mock split across
  deltas is never emitted half-rewritten. `input_json_delta` /
  `thinking_delta` / `signature_delta` and all framing pass through intact.
  A verbatim-echo directive is injected into `system` (toggle:
  `WYLOC_INJECT_SYSTEM_PROMPT`, default on) so mocks round-trip reliably.

- **Phase 4 — SQL identifier masking + literal scrubbing** ✅ (opt-in,
  `WYLOC_MASK_SQL=true`). Before the detector swap, SQL found in prompt text
  (```sql fences **and** a bare block that parses) is run through
  [`@wyloc/sql-masker`](../sql-masker): proprietary table/schema/column
  identifiers are replaced with semantic-preserving masks
  (`job_postings → postings_<hash>`) and sensitive literals are scrubbed,
  while query-local structure (CTEs, aliases) is preserved so the model still
  gives good advice. The mask pairs fold into the same session store, so the
  response stream rehydrates them alongside `WYLOC_MOCK_` tokens. Needs a
  Python3 + `sqlglot` worker; if it can't start, the gateway logs once and
  falls back to detector-only (no request ever fails for this reason).
- **Phase 5 — OpenAI / Codex support** ✅. A provider-adapter seam
  (`src/adapters/`) factors the wire-format-specific logic — `AnthropicAdapter`
  (behavior-preserving) and `OpenAIAdapter` — behind one interface; both call
  the **same** detector/SQL/rehydration core and session store. The OpenAI
  adapter masks `messages[]` text (system/developer/user/assistant; skips
  `role:"tool"` and never touches `tool_calls`), appends the directive to the
  system message, and rehydrates `choices[].delta.content` from the
  `chat.completion.chunk` stream. `WYLOC_MASK_SQL` works on both providers.
- **Phase 6 — TS/JS code identifier masking** ✅ (opt-in,
  `WYLOC_MASK_CODE=true`). Alongside the SQL pass and before the detector swap,
  TS/JS inside fenced code blocks (```ts ```tsx ```js ```jsx …) is run through
  [`@wyloc/code-masker`](../code-masker): internally-defined classes/functions/
  types/imports get semantic-preserving masks (`BillingReconciler → Class_<hash>`),
  internal URLs/hosts/IPs/paths are masked, comments are stripped, and hardcoded
  secrets are swapped — while external/library APIs (React, lodash, Node) and the
  business logic pass through so the model can still help. Mask pairs fold into
  the same session store and rehydrate in the response. Pure in-process (no
  worker). Works on both providers.
- **Phase 7 — file-read masking** ✅ (on by default, `WYLOC_MASK_FILE_READS`).
  The files Claude Code / Codex read on their own arrive as tool-result content
  (Anthropic `tool_result` blocks, OpenAI `role:"tool"` messages) — previously
  forwarded verbatim. That text is now masked the same way typed text is: the
  **detector runs unconditionally** on it (the core win — secrets/PII in any
  file, incl. `.env`/config/logs that aren't SQL or code), and the SQL / code
  maskers additionally apply when their toggle is on and the content sniffs as
  SQL / TS-JS (a structural masker's output is adopted only if it actually
  masked something, so a plain file a sniff misroutes is never corrupted). The
  tool-call **envelope** — `tool_use_id`/`tool_call_id`/`role`/`type`/`name`/
  `arguments` and non-text blocks — is never touched; only the file text
  payload changes. A per-session content-hash cache makes re-sent history O(1).
  Shares the one store/salt, so a secret seen in a file and in typed text maps
  to the same mock and rehydrates together.
- **Phase 8 — OpenAI Responses API masking** ✅. `/v1/responses` (the wire
  format **Codex** uses — `wire_api: "responses"`) is now masked, not
  passed through. A `ResponsesAdapter` (provider-adapter seam) walks
  `instructions`, `input` (string or message items' `input_text`/`output_text`
  parts), and `function_call_output` content (the file-read equivalent → same
  content-router as Claude Code's `tool_result`); `function_call` args/`call_id`,
  `reasoning` items, and all envelope fields stay byte-intact. Rehydration
  reverses the `response.output_text.delta` stream **and** the terminal
  full-text payloads (`response.output_text.done`, `response.completed`) that
  Chat Completions doesn't re-emit. Reuses the entire masking engine + session
  store/salt; behind the same toggles + graceful degradation.

- **Phase 9 — .env value masking** ✅ (on by default, `WYLOC_MASK_ENV`). An
  .env is the most dangerous file an agent can read — `KEY=value` lines whose
  VALUES are sensitive even when they match no known secret pattern. When a
  block is confidently sniffed as an env file (multiple `KEY=value` lines, env-
  typical comments/sections, no code), every value is masked while keys +
  structure stay visible. Handles `export`, quoted values, `=` inside values,
  empty values, inline comments, mixed-case keys, multiline-quoted values
  (unterminated quotes fall back to detector-only); `=` is the only separator.
  Works for typed/pasted content (all adapters) AND files an agent reads (the
  file-read content-router). The detector always runs regardless, so a missed
  env-classification still catches recognized secrets — but the sniff biases
  toward catching env files (over-masking a non-env block is safe; missing a
  real .env is not). Values swap+rehydrate through the shared store/salt.

**Round trip:** paste a secret → the model never sees it (mock upstream) →
Claude's reply shows your **real** secret (rehydrated inline).

## Standalone install (binary)

The gateway ships as a **standalone executable** — no Node/npm/Python install
required on the target machine.

```bash
# Build a self-contained distribution for this platform
node packages/gateway/scripts/build-binary.mjs        # → dist-bin/<platform>/
```

The distribution is `wyloc` (a Node SEA binary, pinned **Node 22 LTS**) plus a
bundled `runtime/` that makes the **differentiators work out-of-the-box with no
machine prerequisites**:

```
<install>/
  wyloc                    ← the binary
  runtime/python/…         ← relocatable Python + sqlglot  → SQL masking works
  runtime/sql/worker.py    ← the sqlglot sidecar
  runtime/re2/             ← prebuilt RE2  → raw-regex custom patterns work
```

Everything is resolved **relative to the binary** (`src/runtime.ts`), so the
install is relocatable; if a runtime piece is missing the gateway **degrades**
(detector-only / constrained-patterns-only) rather than failing. Verified on a
clean machine with no system Python/RE2: SQL identifiers and raw-regex patterns
both mask. Cross-platform builds run the same script per OS in CI (codesign on
macOS, signtool on Windows; pure-Python sqlglot needs no per-OS compile).

### CLI

```
wyloc                     run the gateway (foreground)
wyloc setup [--yes]       detect Claude Code / Codex / Aider, show changes, point them at the gateway
wyloc unsetup             revert exactly what setup changed (originals restored)
wyloc service <cmd>       install|uninstall|start|stop|status|enable|disable
wyloc status              gateway health + setup status
```

`setup` is **detect → show → confirm → apply**, merging
`ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` into each tool's `settings.json` (existing
settings preserved; changes recorded for a clean `unsetup`).

`service` installs a **launchd agent** (macOS) or **systemd user service**
(Linux) that **starts on login and restarts on crash** (`KeepAlive` /
`Restart=always`).

### Central policy (local OR remote)

The config loads from a local `wyloc.json` (`WYLOC_CONFIG`) **or a URL**
(`WYLOC_CONFIG_URL`) so a company can centralize policy. Remote policy uses
**last-known-good with a fail-closed floor**:

| Situation | Behavior |
|---|---|
| reachable + valid | use it; cache as last-known-good |
| reachable + **invalid** | **fail-closed** (refuse to start) |
| unreachable + cache | run the **cached** policy (loud log) — dev keeps working |
| unreachable + **no cache** | **fail-closed** (never run with no policy) |

A background refresh keeps the cache current (applies on next restart).

## Run it

The detector must be built once (the gateway imports its compiled output):

```bash
npm run build --workspace @wyloc/detector
```

Start the gateway:

```bash
npm start --workspace @wyloc/gateway
# or: npm run dev --workspace @wyloc/gateway   (watch mode)
```

It prints the base URL to use. **Important:** `ANTHROPIC_BASE_URL` is read
once at Claude Code startup, so set it and launch a **fresh** `claude` —
changing it mid-session does nothing.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude     # Claude Code
OPENAI_BASE_URL=http://127.0.0.1:8787 codex         # Codex CLI (chat/completions)
```

Use your real provider key as normal — the gateway just relays it. (Codex reads
`OPENAI_BASE_URL` once at startup, same caveat as `ANTHROPIC_BASE_URL`; for a
custom provider entry use `[model_providers.<id>]` with `wire_api = "chat"`.)

### Health check (no key needed)

```bash
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","upstream":"https://api.anthropic.com"}
```

### Automated tests (no key needed)

```bash
npm test --workspace @wyloc/gateway   # runs all six below
```

- `test-rehydrate-unit.mjs` — token-boundary engine: mocks split across
  pushes / one char at a time, identifier-position skip, unknown-mock
  passthrough.
- `test-passthrough.mjs` — Phase 1: headers, a secret-free body, and SSE
  framing all pass through byte-intact.
- `test-swap.mjs` — Phase 2: a real-shaped AWS key in `system` + a user
  text block is swapped to `WYLOC_MOCK_`, while a `tool_result` carrying
  the same key (control) and a `tool_use` block pass through unchanged.
- `test-roundtrip.mjs` — Phase 3: full round trip. The fake upstream
  echoes the gateway's mock back **split across deltas and tiny byte
  chunks**; asserts the client receives the **real** secret, no mock
  survives, `input_json_delta` is byte-intact, the directive was injected,
  and the event sequence/framing is preserved.
- `test-sql-mask.mjs` — Phase 4 (`WYLOC_MASK_SQL=true`): a prompt with a
  proprietary SQL block + a DB-URL secret literal is masked/scrubbed before
  forwarding (no identifier or secret reaches upstream), and the masked table
  echoed back by the fake upstream rehydrates to its real name in the stream.
- `test-openai-mask.mjs` — Phase 5: an OpenAI `/v1/chat/completions` request
  gets its user text masked (SQL + AWS key + DB-URL) and the directive appended
  to the system message, while assistant `tool_calls` and a `role:"tool"`
  message stay byte-intact; the `chat.completion.chunk` stream rehydrates
  `delta.content` (both a semantic SQL mask and a `WYLOC_MOCK_` token).
- `test-code-mask.mjs` — Phase 6 (`WYLOC_MASK_CODE=true`): a prompt with a
  fenced ```ts block (proprietary class/function/import, internal URL, AWS-key
  secret, a comment) is masked/stripped/swapped before forwarding — external
  imports (React) survive — and the masked class echoed back by the fake
  upstream rehydrates to its real name in the stream.
- `test-responses-mask.mjs` — Phase 8: a `/v1/responses` request with secret/SQL
  in `input`, a code file in `function_call_output`, and `function_call` /
  `reasoning` items → content masked, envelope byte-intact, and the streamed
  response rehydrates end-to-end.
- `test-responses-rehydrate.mjs` — Phase 8 unit: split-mock deltas reassemble,
  the terminal `response.completed` / `output_text.done` full text rehydrates
  (no leak), function-call args pass through.
- `test-file-read-mask.mjs` — Phase 7 (file reads, default on): tool-result
  content carrying SQL, TS code, and a plain `.env` secret is masked (detector
  always; SQL/code per toggle) with the `tool_result` / `role:"tool"` envelope
  and assistant `tool_calls` left byte-intact; a masked class echoed back
  rehydrates in the stream. Covers Anthropic and OpenAI shapes.

## Configuration

All behavior is config-driven (env vars for v1 — this is the seam that
later becomes enterprise central policy). Nothing is hardcoded.

| Env var | Default | Meaning |
| --- | --- | --- |
| `WYLOC_GATEWAY_PORT` | `8787` | Port the proxy listens on |
| `WYLOC_GATEWAY_HOST` | `127.0.0.1` | Bind address (keep on loopback) |
| `WYLOC_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Anthropic upstream origin (`/v1/messages*`) |
| `WYLOC_OPENAI_UPSTREAM_BASE_URL` | `https://api.openai.com` | OpenAI upstream origin (`/v1/chat/completions`) |
| `WYLOC_ON_DETECT` | `swap` | `swap` (replace + forward) or `block` (reject) |
| `WYLOC_INJECT_SYSTEM_PROMPT` | `true` | Inject the verbatim-echo `system` directive |
| `WYLOC_MASK_SQL` | `false` | Mask SQL identifiers + scrub literals via @wyloc/sql-masker (needs Python3 + sqlglot) |
| `WYLOC_SQL_DIALECT` | `postgres` | SQL dialect for the masker's parser (postgres/snowflake/bigquery/…) |
| `WYLOC_MASK_CODE` | `false` | Mask TS/JS identifiers + internal infra + strip comments in fenced code blocks via @wyloc/code-masker (pure, no worker) |
| `WYLOC_MASK_CODE_MEMBERS` | `false` | Also mask methods/properties of internal classes (well-typed code only) |
| `WYLOC_MASK_FILE_READS` | `true` | Mask the content of tool results (files the agent read): detector always; SQL/code/env per their toggles. Structure never touched |
| `WYLOC_MASK_ENV` | `true` | When content is confidently an env file, mask every KEY=value's VALUE (keys + structure kept). Applies to typed/pasted + file-read content |
| `WYLOC_CONFIG` | `./wyloc.json` | Path to the company config file (see below) |
| `WYLOC_VERBOSE` | `true` | Operational logging (never logs secrets) |

## Company configuration — `wyloc.json`

A company declares its org-specific masking rules **once** in `wyloc.json`
instead of hand-coding integration. It is loaded at startup, **validated
fail-closed**, and compiled into every masking surface (detector, sql-masker,
code-masker, gateway). See [`wyloc.example.json`](./wyloc.example.json) for a
complete example.

It controls:

- **Custom patterns** — org-specific sensitive values (employee IDs, account
  numbers, project codenames…) detected and swapped like any secret. Authored
  with **constrained, safe-by-construction types** — no regex expertise needed:
  - `prefix` — a literal prefix + a bounded format (`EMP-` + 6 digits)
  - `context` — a value shape only near a keyword (`8 digits` within 16 chars of `account`)
  - `list` — exact terms/substrings (codenames, the blocklist)
  - `known` — pre-vetted shapes by name (`ipv4`, `email`, `uuid`, `mac`, `us_phone`, `iban`)
  - `regex` — an **advanced** escape hatch (must set `"advanced": true`, requires
    `examples`, gets static ReDoS rejection, and runs on the **RE2** engine —
    linear-time, can't backtrack. If `re2` isn't installed the gateway
    fail-closes rather than run raw regex unsafely.)
- **`internalScopes`** — bare import scopes (`@acme/*`) the code-masker treats as internal.
- **`internalDomains` / `internalHosts` / `internalTlds`** — internal infra masked in strings/URLs.
- **`blocklist`** — proprietary terms masked everywhere.
- **`policy`** — masking category toggles (`sql`, `code`, `fileReads`, `members`, `pii`).
- **`logging`** — per-category granularity (metadata-only is enforced regardless).

**Fail-closed validation.** The whole file is validated before the gateway
binds a port: structure, unknown/typo keys (rejected with a *did you mean*
hint), every pattern compiles, self-tests against its `examples`, no
catastrophic-backtracking regex, no duplicate ids. **Any** problem → the gateway
prints every issue and **refuses to start**. A security tool on a broken config
gives false protection.

**Precedence:** `wyloc.json` **>** environment variables **>** defaults for
security-policy fields (company policy is authoritative — a stray local env var
can't silently weaken a fleet-wide rule). Operational fields (`port`, `host`,
upstream URLs) stay env-driven. **No `wyloc.json` present → behavior is exactly
the env-only path above** (fully backward compatible).

> Pattern `name`s/`id`s are non-sensitive labels — they shape the mock the model
> sees (e.g. `WYLOC_MOCK_EMPLOYEE_ID_…`). Never put a secret value in a name.

## Privacy model

Consistent with the browser extension: real↔mock mappings live **only in
process memory**, scoped per session, **never written to disk, never
logged**. The logger is metadata-only — at most a finding's coarse `type`,
never its value, never the prompt body.
