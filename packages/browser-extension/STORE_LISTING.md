# Chrome Web Store Listing

## Name
AI-DLP — Prompt Secret Guard

## Short description (132 char max)
Detects API keys, passwords, and secrets before you send them. Works everywhere. Local-only — nothing leaves your browser.

## Detailed description

Stop leaking credentials to AI tools.

Developers paste API keys, database URLs, .env files, and private keys into ChatGPT, Claude, Gemini, Copilot, and dozens of other tools every day. AI-DLP catches those secrets before they leave your machine.

HOW IT WORKS

When you press Enter or click Send on any web page, AI-DLP scans your text for credentials. If it finds one, it holds submission and shows a clear, non-intrusive banner:

• Block — high-confidence production secrets (AWS keys, database URLs with passwords, private keys) are held until you explicitly choose to proceed.
• Warn — possible secrets (JWTs, test keys, high-entropy strings) show a dismissable warning.
• Redact — one click replaces detected secrets with safe placeholders like [REDACTED_AWS_ACCESS_KEY].

WHAT IT DETECTS

• AWS access keys and secret keys
• Google Cloud API keys and service account files
• Azure storage keys
• GitHub, GitLab, and Slack tokens
• Stripe live and test keys
• OpenAI and Anthropic API keys
• JWTs and OAuth bearer tokens
• PEM-encoded private keys
• Database connection strings with embedded passwords
• .env credential assignments
• High-entropy strings near credential keywords

PRIVACY — BY DESIGN, NOT BY PROMISE

• Zero network requests. None. Ever. Check the Network tab yourself.
• No account, no sign-in, no telemetry, no analytics.
• Your prompt text is scanned in memory and immediately discarded. Never stored, never logged, never transmitted.
• The only thing stored is a local count of detected secret types — no values, no text.
• Fully open for inspection: the extension is unminified so you can read every line.

WORKS EVERYWHERE

AI-DLP protects you on every website — not just a curated list of AI tools. ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok, DeepSeek, Mistral, Slack, Jira, email, internal tools — if it has a text input and you're about to paste a secret, AI-DLP catches it.

BUILT FOR DEVELOPERS

• Non-intrusive: no constant scanning, no background activity. Only activates on submit.
• Smart allowlisting: localhost URLs, example values, test prefixes, and placeholder keys are automatically ignored.
• Low false-positive rate: entropy-only matches require nearby context keywords. Common patterns (git SHAs, UUIDs, hex hashes) are excluded.
• Dev-aware: secrets in dev/test contexts are warned, not blocked. Production secrets are blocked.

## Category
Developer Tools

## Language
English

## Tags (up to 5)
security, DLP, API keys, secrets, developer tools
