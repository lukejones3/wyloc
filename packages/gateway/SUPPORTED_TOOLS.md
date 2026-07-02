# Supported agentic-coding tools

**The single source of truth for what Wyloc covers.** How each tool routes
through the gateway, what wire format it speaks, and what that means for
coverage. The masking engine (detector, SQL, code, `.env`, file-read/tool-result,
config) is **wire-agnostic and identical across every adapter** — coverage is
purely a question of *wire format* + *routing*, never of which secrets get
masked. **What that engine masks — the languages and content types — is the
next section.**

## Languages & content Wyloc masks

The authoritative answer to *"what does Wyloc mask, and what's on by default?"*
Everything below applies to **both** typed/pasted fenced code blocks **and**
the files an agent reads (tool-result content) — the same engine, both paths.

**Always on** (not language-specific, cannot be narrowed away):

- **Secrets / credentials** — 80+ types via `@wyloc/detector` (AWS, GitHub,
  Stripe, OpenAI/Anthropic, DB URLs, JWTs, PEM keys, `.env` assignments, …).
- **PII** — credit-card + SSN (togglable via `policy.pii`).
- **`.env` values** — every `KEY=value` value when content sniffs as an env file
  (`WYLOC_MASK_ENV`, default on).

**Code & query languages** — masks internal/proprietary identity (internal
types/functions/packages, internal import paths, internal URLs/hosts/paths,
hardcoded secrets), leaves external/stdlib/library identity and business logic
untouched, strips comments, and rehydrates the model's reply in-session:

| Language(s) | Masker | Default | Internal-vs-external signal | Verification |
| --- | --- | --- | --- | --- |
| **SQL** | `@wyloc/sql-masker` | **on** | query structure (physical tables vs CTEs/aliases), `sqlglot` parse | unit + integration + per-platform binary |
| **TS / JS** (`ts tsx js jsx mjs cjs`) | `@wyloc/code-masker` | **on** | TypeScript compiler API: imports + scope | unit + integration |
| **Go, Java, C#, Kotlin, Python, Rust, C, C++** | `@wyloc/poly-masker` | **on** | import/package system + `internalPackagePrefixes` (auto-discovered) + project symbol index | unit + integration + per-platform binary |
| **COBOL** | `@wyloc/poly-masker` | **opt-in** | DATA DIVISION / paragraph declarations + copybook index; fixed-format column-safe masks | unit + integration + per-platform binary |

The nine poly languages parse with one tree-sitter layer (in-process WASM,
lazy-loaded per enabled language). **COBOL is opt-in** because its grammar is
9.5 MB and (under a dev/from-source Node ≥23) needs a `--liftoff-only` re-exec;
the shipped binary pins Node 22 and bundles the grammar, so it just works when
enabled. Member/method masking is **off** for all poly languages (on where the
TS masker can prove type-completeness).

**Configuring which languages are on** — `wyloc.json` `languages`
(or `WYLOC_MASK_LANGUAGES`). **Omit it for the sensible default** (the common
eight — COBOL off). When present it is authoritative:

```jsonc
{ "version": 1, "languages": ["go", "python"] }        // narrow to what you use
{ "version": 1, "languages": ["defaults", "cobol"] }   // common set + COBOL (future-proof)
{ "version": 1, "languages": ["all"] }                 // everything incl. COBOL
{ "version": 1, "languages": ["none"] }                // poly masking off
```

Unknown ids / keyword typos fail closed with a *did you mean* hint. TS/JS and
SQL are governed by `policy.code` / `policy.sql` (both default on), not this
list. **Documented gray zones** (safe failure = under-mask, never mismask):
COBOL dialect variance (vendor extensions like EXEC CICS/SQL may not parse →
detector-only); C/C++ under-mask around macros/`#define` (preprocessor identity
is left alone); packageless-Java / def-less-Python snippets fall to the TS/JS
sniff or detector-only; non-streaming (whole-JSON) response bodies aren't
rehydrated — rehydration is streaming-only today.

## The two make-or-break questions

1. **Can the tool's traffic be pointed at the gateway?** (a configurable
   base URL / OpenAI-compatible endpoint, or an origin override)
2. **Does the tool's agentic file-reading go *through that same endpoint*?**
   If the agent runs server-side and reads files on a vendor backend, coverage
   is impossible at this layer — it needs enterprise network-level routing. A
   **local-process agent** (a CLI or an IDE extension on your machine, with no
   vendor backend) reads files locally and sends their contents to the LLM
   inside the request it makes to the configured endpoint, so file-reads route
   through the gateway. This is **doc/architecture-confirmed**; ⚠ flags where
   only a live run against a real install can make it *end-to-end-verified*.

## Routing constraint (every OpenAI-compatible tool)

The gateway routes by **path**: `/v1/chat/completions` → its OpenAI upstream,
`/v1/messages` → Anthropic, `/v1/responses` → OpenAI Responses,
`/v1beta/models/*:generateContent` → Gemini. Each upstream is a **single**
configurable value (`WYLOC_OPENAI_UPSTREAM_BASE_URL`, default `api.openai.com`,
etc.). So an OpenAI-compatible tool is covered when its backend is that one
upstream; for a non-OpenAI OpenAI-compatible backend (OpenRouter, DeepSeek, a
local server) point the gateway's upstream at it — one upstream per gateway, no
per-request provider routing.

For every OpenAI-compatible tool the base URL to configure is
**`http://<gateway-host>:<port>/v1`** (the client appends `/chat/completions`).

---

## Group A — covered today by the OpenAI Chat adapter

All speak **OpenAI Chat Completions** (`/v1/chat/completions`), masked fully.

| Tool | Base-URL config | Wire format | File-reads via endpoint? | `wyloc setup` | Verification |
| --- | --- | --- | --- | --- | --- |
| **Aider** | `~/.aider.conf.yml` → `openai-api-base` (also `OPENAI_API_BASE` env) | Chat Completions (litellm) | Yes — adds file contents to the prompt | **Automated** | **live-verified** (v0.86.2): typed secret masked upstream + rehydrated, via BOTH `.aider.conf.yml` `openai-api-base` and the env var; setup unit-tested |
| **Goose** | `OPENAI_HOST` env (`GOOSE_PROVIDER=openai`) | Chat Completions | Yes — local CLI/desktop | Manual* | **live-verified** (v1.38.0): `OPENAI_HOST` → gateway, typed secret masked + rehydrated; `config.yaml` key still unverified → no auto-setup |
| **OpenCode** | `opencode.json` → `provider.<id>.options.baseURL` | Chat Completions | Yes — local CLI | Manual | doc-confirmed (OpenAI Chat, AI SDK); ⚠ could not drive `opencode run` headlessly in the test env (it printed its model header but emitted no API call) — routing inferred from the identical Chat wire format verified live in Aider + Goose |
| **Continue** | `~/.continue/config.yaml` → per-model `apiBase` | Chat Completions | Yes — local IDE extension | Manual | doc-confirmed; ⚠ needs VS Code — not headless-testable here |
| **Cline** | VS Code UI → "OpenAI Compatible" + Base URL (extension globalState) | Chat Completions | Yes — local IDE extension, no backend | Manual** | doc-confirmed; ⚠ needs VS Code — not headless-testable here |
| **Roo Code** | VS Code UI (globalState `ProviderProfiles`) | Chat Completions | Yes — local IDE extension (Cline fork) | Manual** | doc-confirmed; ⚠ needs VS Code — not headless-testable here |
| **Kilo Code** | VS Code UI (globalState) | Chat Completions | Yes — local IDE extension | Manual** | doc-confirmed; ⚠ needs VS Code — not headless-testable here |

\* **Goose**: covered as-is, but `wyloc setup` does **not** auto-wire it — only
the `OPENAI_HOST` *env var* is doc-confirmed; the exact `config.yaml` key is not,
and writing a wrong key is worse than documenting.

\** **Cline / Roo / Kilo**: the base URL lives in VS Code **extension global
state** (a SQLite `state.vscdb`), not a plain config file — no safe file for
`wyloc setup` to write, so configured by hand in the extension settings panel.

---

## Covered by the dedicated Gemini adapter

| Tool | Routing | Wire format | File-reads via endpoint? | `wyloc setup` | Verification |
| --- | --- | --- | --- | --- | --- |
| **Gemini CLI** | `GOOGLE_GEMINI_BASE_URL` env overrides the origin → gateway | Google `generateContent` / `streamGenerateContent` | Yes — `functionResponse.response` through the file-read router | Manual† | **live-verified** (v0.46.0): typed-secret + agentic file-read both masked upstream and rehydrated |

The gateway masks `/v1beta/models/*:generateContent` and `:streamGenerateContent`
(other `/v1beta/*` actions — `:countTokens`, `:embedContent` — forward unmasked).
It masks `contents[].parts[].text` + `systemInstruction` parts, routes
`functionResponse.response` (where read file content lands) through the same
content-router as the other adapters, and leaves `functionCall` /
`functionDeclarations` / `inlineData` byte-intact. The streamed response is
rehydrated over its incremental SSE deltas.

† **Gemini CLI** is env-only (`GOOGLE_GEMINI_BASE_URL`) with no doc-confirmed
config file for the endpoint, so — same call as the globalState/env-only tools
above — the manual step is documented rather than auto-wired. (Live testing also
showed headless runs need an auth type selected and the workspace trusted — see
the snippet below; interactive use just needs the two env vars.)

### Manual configuration snippets

**Aider** (automated by `wyloc setup`, shown for reference) — `~/.aider.conf.yml`:
```yaml
openai-api-base: "http://127.0.0.1:8787/v1"
```

**Goose** — environment (most reliable):
```sh
export GOOSE_PROVIDER=openai
export OPENAI_HOST=http://127.0.0.1:8787   # Goose appends /v1/chat/completions
```

**OpenCode** — `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "wyloc": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Wyloc gateway",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": { "gpt-4o": { "name": "gpt-4o (via wyloc)" } }
    }
  }
}
```

**Continue** — `~/.continue/config.yaml` (set `apiBase` on each OpenAI model):
```yaml
models:
  - name: gpt-4o (via wyloc)
    provider: openai
    model: gpt-4o
    apiBase: http://127.0.0.1:8787/v1
```

**Cline / Roo Code / Kilo Code** — extension settings panel: API Provider =
**OpenAI Compatible**, Base URL = `http://127.0.0.1:8787/v1`, API Key = your real
OpenAI key (the gateway relays it).

**Gemini CLI** — environment (origin override; the CLI appends the
`/v1beta/models/...` path). The env var is `GOOGLE_GEMINI_BASE_URL` (verified
against gemini-cli v0.46.0 — *not* `GEMINI_BASE_URL`):
```sh
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787   # use your Gemini API key as normal
# Headless/CI also needs an auth type + trusted workspace:
#   settings.json: {"security":{"auth":{"selectedType":"gemini-api-key"}}}
#   and: gemini --yolo --skip-trust  (or GEMINI_CLI_TRUST_WORKSPACE=true)
```

---

## Vendor-locked backends — require enterprise network-level routing

These tools run their agent on a **vendor backend**, so the agent's traffic
(including the file contents it reads) never passes through a base URL you
control. Wyloc cannot mask them at the client layer; the only option is
**enterprise network-level routing** (e.g. an egress proxy / MITM on the
corporate network), the same situation as Cursor's agent. **No adapter is
built or planned** for the locked mode — there is nothing to point at the
gateway.

Several of them *also* offer a **BYOK mode** that bypasses the vendor backend and
hits a configurable endpoint directly. In that mode they drop to **Group A** and
are covered as-is (point BYOK at the gateway).

| Tool | Locked default (→ enterprise routing) | BYOK mode (→ covered) | Verification |
| --- | --- | --- | --- |
| **GitHub Copilot** | Native models go through GitHub's auth proxy (`api.githubcopilot.com`) on GitHub OAuth tokens — locked. | **BYOK** (2026, VS Code + Copilot CLI): custom base URL, **OpenAI-compatible** → Group A (Chat) | doc-confirmed; ⚠ BYOK file-read routing needs live run |
| **Windsurf** | Cascade agent runs on the Codeium backend — locked. | Some builds expose a custom OpenAI-compatible base URL → Group A | doc-confirmed; ⚠ varies by build/version |
| **Augment Code** | Default agent runs on Augment's proprietary context-engine backend — locked. | **BYOK** sets `base_url` + wire protocol (OpenAI-compatible *or* Anthropic-native) → Group A (both covered) | doc-confirmed; ⚠ BYOK file-read routing needs live run |
| **AWS Kiro** | Agentic IDE; models served via AWS/Bedrock but IDE→model traffic goes through Kiro's service — no user-configurable endpoint found. | None found. | ⚠ doc-inconclusive; leaning locked |
| **Cursor (agent)** | Composer/agent runs server-side on Cursor's backend; file-reads never hit a configurable endpoint — locked. | Chat with a custom OpenAI base URL covers chat only, not the agent. | doc-confirmed |

> **Reason (all of the above):** vendor-locked agent backend — the same class of
> limitation as Cursor's agent. Masking requires the request (with its file
> contents) to traverse an endpoint you control, which the locked mode does not.

---

## Verification labels

- **live-verified** — the real tool (named version) was run against the gateway:
  its traffic routed through, the secret was masked in what the gateway forwarded
  to a captured upstream, and the response rehydrated back to the real value.
- **doc-confirmed** — base-URL config + wire format verified against the tool's
  own documentation.
- **⚠ end-to-end needs live run** — file-read routing and full mask→rehydrate
  round-trip inferred from the tool's local-agent architecture, not yet
  exercised against a real install.
- **⚠ doc-inconclusive** — the tool's docs did not confirm a custom-endpoint
  path; the verdict is the best available inference and should be re-checked.
- **unit-tested** — exercised by the gateway test suite. `wyloc setup`/`unsetup`:
  Claude Code, Codex, Aider (`test-cli.mjs`). Adapter masking + rehydration:
  Anthropic, OpenAI-Chat, OpenAI-Responses, **Gemini** (`test-gemini-*.mjs`).
