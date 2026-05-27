/**
 * HuggingChat adapter (huggingface.co/chat).
 *
 * HuggingChat uses a textarea for prompt input with a standard
 * SvelteKit-based UI.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const huggingchatAdapter: SiteAdapter = {
  id: "huggingchat",
  label: "HuggingChat",

  matches: (hostname) =>
    hostname === "huggingface.co",

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Chat' i]",
      "textarea[enterkeyhint='send']",
      "textarea[aria-label*='chat' i]",
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
