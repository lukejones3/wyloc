/**
 * Grok adapter (grok.com, formerly x.com/i/grok).
 *
 * Grok's chat interface uses a textarea or contenteditable, similar
 * to other React-based LLM UIs.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const grokAdapter: SiteAdapter = {
  id: "grok",
  label: "Grok",

  matches: (hostname) =>
    hostname === "grok.com" ||
    hostname.endsWith(".grok.com"),

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='message' i]",
      "textarea[aria-label*='message' i]",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Send' i]",
      "button[aria-label*='Submit' i]",
      "button[type='submit']",
    ]),

  readText: (input) => {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    return input.textContent ?? "";
  },
};
