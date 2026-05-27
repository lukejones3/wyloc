/**
 * Poe adapter (poe.com).
 *
 * Poe is Quora's multi-model chat interface. Uses a textarea for prompt
 * input with a React-based SPA.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const poeAdapter: SiteAdapter = {
  id: "poe",
  label: "Poe",

  matches: (hostname) =>
    hostname === "poe.com" ||
    hostname === "www.poe.com",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[class*='TextArea' i]",
      "textarea[placeholder*='message' i]",
      "textarea[placeholder*='Talk' i]",
      "div[contenteditable='true'][role='textbox']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[class*='Send' i]",
      "button[aria-label*='Send' i]",
      "button[class*='submit' i]",
    ]),

  readText: (input) => {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    return input.textContent ?? "";
  },
};
