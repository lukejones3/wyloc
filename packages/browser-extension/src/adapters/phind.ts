/**
 * Phind adapter (phind.com).
 *
 * Phind is a developer-focused AI search/chat. Uses a textarea for
 * prompt input.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const phindAdapter: SiteAdapter = {
  id: "phind",
  label: "Phind",

  matches: (hostname) =>
    hostname === "www.phind.com" ||
    hostname === "phind.com",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Search' i]",
      "textarea[name='q']",
      "textarea",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Send' i]",
      "button[aria-label*='Search' i]",
      "button[type='submit']",
    ]),

  readText: (input) => {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    return input.textContent ?? "";
  },
};
