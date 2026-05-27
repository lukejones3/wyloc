/**
 * Perplexity adapter (perplexity.ai).
 *
 * Perplexity uses a textarea for prompt input. The interface is
 * relatively standard React with accessible labels.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const perplexityAdapter: SiteAdapter = {
  id: "perplexity",
  label: "Perplexity",

  matches: (hostname) =>
    hostname === "www.perplexity.ai" ||
    hostname === "perplexity.ai",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Search' i]",
      "textarea[aria-label*='Ask' i]",
      "textarea[autofocus]",
      "div[contenteditable='true'][role='textbox']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Submit' i]",
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
