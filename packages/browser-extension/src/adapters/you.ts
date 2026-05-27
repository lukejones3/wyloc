/**
 * You.com adapter (you.com).
 *
 * You.com's chat interface uses a textarea or search-style input.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const youAdapter: SiteAdapter = {
  id: "you",
  label: "You.com",

  matches: (hostname) =>
    hostname === "you.com" ||
    hostname === "www.you.com",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='message' i]",
      "textarea[aria-label*='Ask' i]",
      "input[type='text'][placeholder*='Ask' i]",
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
    if (input instanceof HTMLInputElement) {
      return input.value;
    }
    return input.textContent ?? "";
  },
};
