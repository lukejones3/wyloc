/**
 * Mistral adapter (chat.mistral.ai / Le Chat).
 *
 * Mistral's Le Chat uses a standard textarea or contenteditable.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const mistralAdapter: SiteAdapter = {
  id: "mistral",
  label: "Mistral Le Chat",

  matches: (hostname) =>
    hostname === "chat.mistral.ai" ||
    hostname.endsWith(".mistral.ai"),

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='message' i]",
      "textarea[aria-label*='Chat' i]",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'].ProseMirror",
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
