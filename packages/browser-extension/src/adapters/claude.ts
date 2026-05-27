/**
 * Claude adapter (claude.ai).
 *
 * Claude's prompt input is a contenteditable ProseMirror <div>. Same
 * fallback-layered selector strategy as the ChatGPT adapter.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const claudeAdapter: SiteAdapter = {
  id: "claude",
  label: "Claude",

  matches: (hostname) =>
    hostname === "claude.ai" || hostname.endsWith(".claude.ai"),

  inputKind: "contenteditable",

  findInput: () =>
    firstMatch([
      "div[contenteditable='true'].ProseMirror",
      "div[contenteditable='true'][role='textbox']",
      "fieldset div[contenteditable='true']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label='Send message']",
      "button[aria-label*='Send']",
      "fieldset button[type='submit']",
    ]),

  readText: (input) => {
    const blocks = input.querySelectorAll<HTMLElement>(":scope > *");
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((b) => b.textContent ?? "")
        .join("\n");
    }
    return input.textContent ?? "";
  },
};
