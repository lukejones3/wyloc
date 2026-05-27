/**
 * Gemini adapter (gemini.google.com).
 *
 * Gemini uses a rich-text input (contenteditable) inside a material
 * design wrapper. The input has historically used `.ql-editor` (Quill)
 * or a plain contenteditable with `aria-label` referencing "prompt".
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const geminiAdapter: SiteAdapter = {
  id: "gemini",
  label: "Gemini",

  matches: (hostname) =>
    hostname === "gemini.google.com" ||
    hostname.endsWith(".gemini.google.com"),

  inputKind: "contenteditable",

  findInput: () =>
    firstMatch([
      ".ql-editor[contenteditable='true']",
      "div[contenteditable='true'][aria-label*='prompt' i]",
      "div[contenteditable='true'][aria-label*='Enter' i]",
      "rich-textarea div[contenteditable='true']",
      "div[contenteditable='true'][role='textbox']",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Send' i]",
      "button[aria-label*='Submit' i]",
      "button.send-button",
      "mat-icon-button[aria-label*='Send' i]",
    ]),

  readText: (input) => {
    const blocks = input.querySelectorAll<HTMLElement>(":scope > p, :scope > div");
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((b) => b.textContent ?? "")
        .join("\n");
    }
    return input.textContent ?? "";
  },
};
