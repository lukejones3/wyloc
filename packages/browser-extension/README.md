# @ai-dlp/browser-extension

Browser extension for **AI-DLP** — intercepts AI prompts and detects
secrets before they are sent. Manifest V3, Chrome / Edge.

Local-only: no sign-in, no telemetry, no network. All detection runs in
the page via the bundled `@ai-dlp/detector`.

## Supported sites

- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Claude (`claude.ai`)

Adding more (Gemini, Copilot, …) is a small, isolated change — see
**Adding a site** below.

## Build

From the **monorepo root** (`ai-dlp/`):

```bash
npm install
npm run build --workspace @ai-dlp/detector
npm run build --workspace @ai-dlp/browser-extension
```

The detector must be built first — the extension bundles it. Output
lands in `packages/browser-extension/dist/` — that folder *is* the
unpacked extension.

For active development: `npm run watch --workspace @ai-dlp/browser-extension`.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select `packages/browser-extension/dist/`.

Then open ChatGPT or Claude. Paste a fake-shaped secret (e.g.
`AKIA5XQ2WJ8NPLR3MKVT`) into the prompt and press Enter — the warning
banner should appear and submission should be held.

After any rebuild, click the refresh icon on the extension card in
`chrome://extensions`.

## How it works

- A **content script** (`content.js`) runs on the supported sites. It
  listens, in the capture phase, for Enter keypresses and send-button
  clicks on the prompt input.
- On a submit attempt it reads the prompt text and runs `scan()`. If
  clean, it does nothing — the submission proceeds untouched.
- If a secret is found it cancels the event and shows a Shadow-DOM
  banner: **warn** (dismissable) or **block** (held until the user
  explicitly chooses "Send anyway"). The user can also **redact**, which
  replaces secrets with typed placeholders in place.
- A **background worker** stores metadata-only incident counts in
  `chrome.storage.local`. The **popup** shows those counts. No prompt
  text or secret value is ever stored or transmitted.

## Adding a site

1. Create `src/adapters/<site>.ts` exporting a `SiteAdapter` (copy
   `claude.ts` as a template — the contract is in `adapters/types.ts`).
2. Register it in `src/adapters/index.ts` (`SITE_ADAPTERS` array).
3. Add the host to `host_permissions` **and** `content_scripts.matches`
   in `manifest.json`.

No detection, UI, or interception code changes. That isolation is
deliberate.

## Layout

```
manifest.json          MV3 manifest
build.mjs              esbuild bundler (inlines the detector)
popup.html             popup markup
content.css            near-empty (banner is Shadow-DOM scoped)
icons/                 extension icons (placeholder art for now)
src/
  content.ts           interception + detection + banner wiring
  background.ts         metadata-only incident storage
  popup.ts              local stats view
  incident-bridge.ts    safe metadata -> background channel
  adapters/
    types.ts            SiteAdapter contract
    index.ts            registry — append here to add a site
    chatgpt.ts          ChatGPT adapter
    claude.ts           Claude adapter
  ui/
    banner.ts           Shadow-DOM warning banner
```

## Notes

- Icons are placeholder art — replace `icons/*.png` before any store
  submission.
- Firefox support is possible (MV3) with minor `background` and API
  differences; not wired up yet.
- LLM sites reship their DOM without notice. Each adapter uses layered
  fallback selectors, but selectors are the expected maintenance point.
