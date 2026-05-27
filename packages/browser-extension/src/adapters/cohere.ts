/**
 * Cohere Coral adapter (coral.cohere.com).
 *
 * Coral is Cohere's chat interface. Uses a textarea or contenteditable
 * for prompt input.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const cohereAdapter: SiteAdapter = {
  id: "cohere",
  label: "Cohere Coral",

  matches: (hostname) =>
    hostname === "coral.cohere.com" ||
    hostname === "dashboard.cohere.com",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='message' i]",
      "textarea[placeholder*='Chat' i]",
      "textarea[aria-label*='message' i]",
      "div[contenteditable='true'][role='textbox']",
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
