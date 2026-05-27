/**
 * DeepSeek adapter (chat.deepseek.com).
 *
 * DeepSeek's chat UI uses a textarea or contenteditable input. The
 * interface follows standard React patterns.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export const deepseekAdapter: SiteAdapter = {
  id: "deepseek",
  label: "DeepSeek",

  matches: (hostname) =>
    hostname === "chat.deepseek.com" ||
    hostname.endsWith(".deepseek.com"),

  inputKind: "textarea",

  findInput: () =>
    firstMatch([
      "textarea#chat-input",
      "textarea[placeholder*='message' i]",
      "textarea[placeholder*='Send' i]",
      "textarea[placeholder*='DeepSeek' i]",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'].ProseMirror",
    ]),

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Send' i]",
      "div[role='button'][aria-label*='Send' i]",
      "button[class*='send' i]",
    ]),

  readText: (input) => {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    const blocks = input.querySelectorAll<HTMLElement>(":scope > *");
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((b) => b.textContent ?? "")
        .join("\n");
    }
    return input.textContent ?? "";
  },
};
