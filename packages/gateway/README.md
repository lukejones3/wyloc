# @wyloc/gateway

A local proxy that sits between **Claude Code** (and later other CLI/IDE
clients that support a custom base URL) and the Anthropic API. It detects
secrets in outbound prompts and swaps them for `WYLOC_MOCK_` placeholders
**before they leave the machine**, then rehydrates the real values inline
in the streamed response — the same protection as the Wyloc browser
extension, reusing the same [`@wyloc/detector`](../detector) engine.

```
 claude  ──►  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
                     │
                     ▼
            ┌──────────────────┐   real→mock swap (user text only)
            │  @wyloc/gateway  │ ──────────────────────────────────►  api.anthropic.com
            │  (this package)  │ ◄──────────────────────────────────  (your real key)
            └──────────────────┘   mock→real rehydrate (SSE stream)
```

Credentials are **relayed, never replaced**: your real `x-api-key` /
`Authorization`, `anthropic-version`, and `anthropic-beta` headers pass
straight through to the upstream. The gateway never sees a Wyloc account.

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

**Round trip:** paste a secret → the model never sees it (mock upstream) →
Claude's reply shows your **real** secret (rehydrated inline).

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
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Use your real Anthropic key as normal. In Phase 1 everything behaves
exactly like talking to Anthropic directly; the gateway just relays.

### Health check (no key needed)

```bash
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","upstream":"https://api.anthropic.com"}
```

### Automated tests (no key needed)

```bash
npm test --workspace @wyloc/gateway   # runs all four below
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

## Configuration

All behavior is config-driven (env vars for v1 — this is the seam that
later becomes enterprise central policy). Nothing is hardcoded.

| Env var | Default | Meaning |
| --- | --- | --- |
| `WYLOC_GATEWAY_PORT` | `8787` | Port the proxy listens on |
| `WYLOC_GATEWAY_HOST` | `127.0.0.1` | Bind address (keep on loopback) |
| `WYLOC_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Upstream API origin |
| `WYLOC_ON_DETECT` | `swap` | `swap` (replace + forward) or `block` (reject) |
| `WYLOC_INJECT_SYSTEM_PROMPT` | `true` | Inject the verbatim-echo `system` directive |
| `WYLOC_VERBOSE` | `true` | Operational logging (never logs secrets) |

## Privacy model

Consistent with the browser extension: real↔mock mappings live **only in
process memory**, scoped per session, **never written to disk, never
logged**. The logger is metadata-only — at most a finding's coarse `type`,
never its value, never the prompt body.
