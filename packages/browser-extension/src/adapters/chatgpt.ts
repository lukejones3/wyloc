/**
 * ChatGPT adapter (chatgpt.com / chat.openai.com).
 *
 * ChatGPT's prompt input is a contenteditable <div>, id `prompt-textarea`
 * historically, wrapped in ProseMirror. Selectors are intentionally
 * layered most-specific-first with broad fallbacks, because OpenAI
 * reships the DOM without notice — a fallback keeps the extension
 * degrading gracefully instead of silently doing nothing.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const chatgptAdapter: SiteAdapter = {
  id: "chatgpt",
  label: "ChatGPT",

  matches: (hostname) =>
    hostname === "chatgpt.com" ||
    hostname === "chat.openai.com" ||
    hostname.endsWith(".chatgpt.com"),

  inputKind: "contenteditable",

  findInput: () =>
    firstMatch([
      "#prompt-textarea",
      "div[contenteditable='true'].ProseMirror",
      "main div[contenteditable='true']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label*='Send']",
      "#prompt-textarea ~ button",
      "#prompt-textarea + button",
      "form button[type='submit']",
      "main button[class*='send' i]",
    ]),

  readText: (input) => {
    // ProseMirror renders each line as a child block; textContent
    // collapses them, so join block children with newlines to preserve
    // multi-line .env pastes that the detector's structural layer needs.
    const blocks = input.querySelectorAll<HTMLElement>(":scope > *");
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((b) => b.textContent ?? "")
        .join("\n");
    }
    return input.textContent ?? "";
  },
};
