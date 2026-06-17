# Supported agentic-coding tools

How each tool routes through the gateway, what wire format it speaks, and what
that means for coverage. The masking engine (detector, SQL, code, `.env`,
file-read/tool-result, config) is **wire-agnostic and identical across every
adapter** — coverage is purely a question of *wire format* + *routing*, never of
which secrets get masked.

## The two make-or-break questions

1. **Can the tool's traffic be pointed at the gateway?** (a configurable
   base URL / OpenAI-compatible endpoint)
2. **Does the tool's agentic file-reading go *through that same endpoint*?**
   If the agent runs server-side and reads files on a vendor backend (like
   Cursor's agent), coverage is chat-only and an adapter can't help — it needs
   enterprise network-level routing. Every tool below is a **local-process agent**
   (a CLI or an IDE extension running on your machine) with **no vendor backend**:
   it reads files locally and sends their contents to the LLM inside the request
   it makes to the configured endpoint. So file-reads route through the gateway.
   This is **doc/architecture-confirmed**; ⚠ flags where only a live run against a
   real install can make it *end-to-end-verified*.

## Routing constraint (applies to every OpenAI-compatible tool)

The gateway routes by **path**: `/v1/chat/completions` → its OpenAI upstream,
`/v1/messages` → Anthropic, `/v1/responses` → OpenAI Responses. The OpenAI
upstream is a **single** value (`WYLOC_OPENAI_UPSTREAM_BASE_URL`, default
`api.openai.com`). So an OpenAI-compatible tool is covered when its backend is
that one upstream. Using a non-OpenAI OpenAI-compatible backend (OpenRouter,
DeepSeek, a local server)? Point the gateway at it with
`WYLOC_OPENAI_UPSTREAM_BASE_URL` — one upstream per gateway, per-request
provider routing is not supported.

For every OpenAI-compatible tool, the base URL to configure is
**`http://<gateway-host>:<port>/v1`** (the client appends `/chat/completions`).

---

## Group A — covered today by existing adapters

All speak **OpenAI Chat Completions** (`/v1/chat/completions`), which the gateway
masks fully (real protection — unlike Codex's Responses traffic, which only
became masked once the Responses adapter shipped).

| Tool | Base-URL config | Wire format | File-reads through endpoint? | `wyloc setup` | Verification |
| --- | --- | --- | --- | --- | --- |
| **Aider** | `~/.aider.conf.yml` → `openai-api-base` (also `OPENAI_API_BASE` env / `--openai-api-base`) | Chat Completions (via litellm) | Yes — adds file contents to the prompt it sends | **Automated** | config doc-confirmed; ⚠ end-to-end needs live run |
| **Goose** | `~/.config/goose/config.yaml` / `OPENAI_HOST` env (`GOOSE_PROVIDER=openai`) | Chat Completions | Yes — local CLI/desktop agent | Manual* | env/Chat doc-confirmed; ⚠ exact YAML key unverified → no auto-setup |
| **OpenCode** | `opencode.json` → `provider.<id>.options.baseURL` (`@ai-sdk/openai-compatible`) | Chat Completions | Yes — local CLI agent | Manual | doc-confirmed; ⚠ end-to-end needs live run |
| **Continue** | `~/.continue/config.yaml` → per-model `apiBase` (`provider: openai`) | Chat Completions | Yes — local IDE extension | Manual | doc-confirmed; ⚠ end-to-end needs live run |
| **Cline** | VS Code settings UI → "OpenAI Compatible" + Base URL (stored in extension globalState, not a writable file) | Chat Completions | Yes — local IDE extension, open-source, no backend | Manual** | doc-confirmed; ⚠ end-to-end needs live run |
| **Roo Code** | VS Code settings UI → "OpenAI Compatible" + Base URL (globalState / `ProviderProfiles`) | Chat Completions | Yes — local IDE extension (Cline fork) | Manual** | doc-confirmed; ⚠ end-to-end needs live run |
| **Kilo Code** | VS Code settings UI → "OpenAI Compatible" + Base URL (globalState) | Chat Completions | Yes — local IDE extension (Roo/Cline lineage) | Manual** | doc-confirmed; ⚠ end-to-end needs live run |

\* **Goose** is covered as-is, but `wyloc setup` does **not** auto-wire it: only
the `OPENAI_HOST` *env var* is doc-confirmed; the exact `config.yaml` key is not,
and writing a wrong YAML key is worse than documenting. Wire it manually (below)
or set `OPENAI_HOST`/`GOOSE_PROVIDER` in your environment.

\** **Cline / Roo / Kilo** store the base URL in VS Code **extension global
state** (a SQLite `state.vscdb`), not a plain config file. There is no safe,
stable file for `wyloc setup` to write, so these are configured by hand through
the extension's settings panel ("OpenAI Compatible" provider → Base URL). The
masking itself is fully covered once the traffic is pointed at the gateway.

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

**Cline / Roo Code / Kilo Code** — in the extension settings panel: API Provider
= **OpenAI Compatible**, Base URL = `http://127.0.0.1:8787/v1`, API Key = your
real OpenAI key (the gateway relays it).

---

## Group B — needs its own adapter (or can't be routed)

| Tool | Wire format | Routable? | Verdict |
| --- | --- | --- | --- |
| **Gemini CLI** | Google `generateContent` / `streamGenerateContent` — **not** OpenAI | Yes — `GEMINI_BASE_URL` env points it at a custom endpoint | **Needs a Gemini adapter.** The endpoint is configurable (routing is fine), but the wire format is Google's, which no existing adapter speaks. Scoped in Phase 2. |

(Phase 2 also investigates GitHub Copilot, Windsurf, Augment Code, and AWS Kiro —
see the Phase 2 scope report.)

---

## Verification labels

- **doc-confirmed** — base-URL config + wire format verified against the tool's
  own documentation.
- **⚠ end-to-end needs live run** — file-read routing and full mask→rehydrate
  round-trip inferred from the tool's local-agent architecture (no vendor
  backend), but not yet exercised against a real install.
- **unit-tested** — `wyloc setup`/`unsetup` for the tool is covered by
  `test-cli.mjs` (currently: Claude Code, Codex, Aider).
