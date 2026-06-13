# Wyloc
 
**Prompt-time Data Loss Prevention for generative AI.**
 
Wyloc detects API keys, passwords, database URLs, and other credentials in text *before* you submit them to ChatGPT, Claude, Gemini, or any other AI tool — across the browser and the terminal. Everything runs locally. No account, no telemetry, no network requests.
 
🛡️ **[Install for Chrome →](https://chromewebstore.google.com/detail/lpfhmmmelnkpgccgpehejiohpaddjgbp)** &nbsp;&nbsp;·&nbsp;&nbsp; 🌐 **[wyloc.dev](https://wyloc.dev)**
 
---
 
## Why this exists
 
Developers paste credentials into LLMs every day — `.env` files, database connection strings, API keys in stack traces, secrets in config snippets. Existing secret scanners (GitGuardian, Snyk) catch leaks *after* they hit a git repo. Network-level DLP (Netskope, Zscaler) blocks entire sites and breaks workflows. Tools that hook AI editors tend to *hard-block*, stopping you cold.
 
Wyloc is the missing layer: client-side, surgical, and built to keep you working. It stops the leak at the moment of submission — and instead of blocking you, it can swap secrets for safe placeholders and restore them automatically, so the AI still helps and your secret never leaves your machine.
 
## How it works
 
1. **Detect** — when you submit text (in the browser or through the local gateway), Wyloc scans it for credentials in milliseconds.
2. **Warn or block** — if a secret is found, submission is held and you see exactly what was caught.
3. **Redact** — replace secrets with safe placeholders (`[REDACTED_AWS_ACCESS_KEY]`) and keep editing.
4. **Swap & rehydrate** — replace a secret with a realistic mock so the AI can still reason about your prompt, then restore the real value in the response. The model never sees the secret; you never lose your flow.
## What it catches
 
**80+ credential types**, sourced from battle-tested detection rulesets, across every major category:
 
- **Cloud providers** — AWS access/secret keys, GCP API keys & service account files, Azure storage keys
- **Source control & CI** — GitHub, GitLab (full token family), and more
- **Payments** — Stripe (live & test) and others
- **AI & ML services** — OpenAI, Anthropic, and more
- **Databases** — connection strings with embedded passwords, hosted DB tokens
- **Developer & SaaS tools** — npm, Notion, Linear, Sentry, Slack, and dozens more
- **Generic secrets** — JWTs, OAuth bearer tokens, PEM private keys, `.env` credential assignments, and high-entropy strings gated by nearby context
The detection engine uses a three-tier model (distinctive-prefix, structural, and context-gated high-entropy patterns) with compile-time safety checks to keep false positives low.
 
## Privacy by design
 
- **Zero network requests** from the extension. Verify it yourself — open the Network tab.
- **No account or sign-in.**
- **Your prompt text is scanned in memory and immediately discarded.** Never stored, never logged, never transmitted.
- **The only thing stored is a local count of secret types caught** — never values, never text.
- **Mappings between real secrets and their placeholders live in memory only** and are wiped when the session ends.
- **Unminified code.** Read every line.
## Repository layout
 
This is a monorepo with three packages:
 
~~~
packages/
  detector/             Zero-dependency TypeScript detection engine.
                        Pure logic — runs identically in browser, gateway, and CLI.
  browser-extension/    Chrome / Edge extension (Manifest V3).
                        Universal mode: works on every website.
  gateway/              Local Anthropic-compatible proxy. Protects terminal AI
                        tools (e.g. Claude Code) at the wire level — masking
                        secrets on the request and restoring them on the
                        streamed response, with no change to the developer's flow.
~~~
 
The detector is shared across every surface: add a pattern once, and the browser extension and gateway both gain it.
 
## Local development
 
~~~
git clone https://github.com/lukejones3/wyloc.git
cd wyloc
npm install
npm run build --workspace @wyloc/detector
npm run build --workspace @wyloc/browser-extension
~~~
 
Then load `packages/browser-extension/dist/` as an unpacked extension at `chrome://extensions` (enable Developer mode first).
 
### Run the detector tests
 
~~~
npm test --workspace @wyloc/detector
~~~
 
The fixture suite covers detection accuracy across real-shaped (but fake) secrets and realistic false-positive decoys.
 
## Roadmap
 
- [x] Detection engine (zero dependencies, three-tier pattern model, 80+ patterns)
- [x] Browser extension (Chrome / Edge, universal mode across all websites)
- [x] Site-specific adapters for ChatGPT, Claude, Gemini
- [x] Swap & rehydrate engine (structurally-valid mock replacements that preserve LLM reasoning)
- [x] Local gateway — wire-level interception for terminal AI tools (Claude Code)
- [ ] OpenAI-format support in the gateway (Codex CLI and other OpenAI-compatible clients)
- [ ] Cursor coverage
- [ ] Team dashboard (metadata-only incident aggregation, SSO, audit exports)
## License
 
MIT — see [LICENSE](./LICENSE).
 
## Contact
 
[jones31luke@gmail.com](mailto:jones31luke@gmail.com)
