# Wyloc

**Prompt-time Data Loss Prevention for generative AI.**

Wyloc detects API keys, passwords, database URLs, and other credentials in text *before* you submit them to ChatGPT, Claude, Gemini, or any other AI tool. Everything runs locally in your browser. No account, no telemetry, no network requests.

🛡️ **[Install for Chrome →](https://wyloc.dev)** &nbsp;&nbsp;·&nbsp;&nbsp; 🌐 **[wyloc.dev](https://wyloc.dev)**

---

## Why this exists

Developers paste credentials into LLMs every day — `.env` files, database connection strings, API keys in stack traces, secrets in config snippets. Existing DLP tools (GitGuardian, Snyk) catch leaks *after* they hit a git repo. Network-level DLP (Netskope, Zscaler) blocks entire sites and breaks workflows.

Wyloc is the missing layer: client-side, browser-native, surgical. It stops the leak at the event loop without slowing the developer down.

## How it works

1. **Detect** — when you press Enter or click Send on any web page, Wyloc scans your text for credentials in milliseconds.
2. **Warn or block** — if a secret is found, submission is held. You see exactly what was caught.
3. **Redact** — replace secrets with safe placeholders (`[REDACTED_AWS_ACCESS_KEY]`) and keep editing.

## What it catches

AWS access keys · AWS secret keys · Google Cloud API keys · GCP service account files · Azure storage keys · GitHub tokens · GitLab tokens · Slack tokens · Stripe keys (live & test) · OpenAI API keys · Anthropic API keys · JWTs · OAuth bearer tokens · PEM private keys · Database connection strings · `.env` credential assignments · high-entropy strings near credential keywords

## Privacy by design

- **Zero network requests.** Verify it yourself — open the Network tab.
- **No account or sign-in.**
- **Your prompt text is scanned in memory and immediately discarded.** Never stored, never logged, never transmitted.
- **The only thing stored is a local count of secret types caught** — never values, never text.
- **Unminified code.** Read every line.

## Repository layout

This is a monorepo with two packages:

    packages/
      detector/             Zero-dependency TypeScript detection engine.
                            Pure logic — runs identically in browser, IDE, and CLI.
      browser-extension/    Chrome / Edge extension (Manifest V3).
                            Universal mode: works on every website.

## Local development

    git clone https://github.com/lukejones3/wyloc.git
    cd wyloc
    npm install
    npm run build --workspace @wyloc/detector
    npm run build --workspace @wyloc/browser-extension

Then load `packages/browser-extension/dist/` as an unpacked extension at `chrome://extensions` (enable Developer mode first).

### Run the detector tests

    npm test --workspace @wyloc/detector

85 fixture tests cover detection accuracy across real-shaped (but fake) secrets and realistic false-positive decoys.

## Roadmap

- [x] Detection engine (zero dependencies, 85 tests passing)
- [x] Browser extension (Chrome / Edge, universal mode across all websites)
- [x] Site-specific adapters for ChatGPT, Claude, Gemini
- [ ] Dummy-swap engine (structurally-valid mock replacements that preserve LLM reasoning)
- [ ] Network-level interception (`fetch` / `XMLHttpRequest` patching)
- [ ] VS Code / Cursor plugin
- [ ] Team dashboard (metadata-only incident aggregation, SSO, audit exports)

## Contributing

Issues and pull requests welcome. For larger changes, open an issue first to discuss the direction.

## License

MIT — see [LICENSE](./LICENSE).

## Contact

[jones31luke@gmail.com](mailto:jones31luke@gmail.com)
