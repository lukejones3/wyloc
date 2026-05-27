/**
 * Copilot adapter (copilot.microsoft.com).
 *
 * Microsoft Copilot (formerly Bing Chat) uses a shadow-DOM-heavy
 * architecture with web components. The prompt input is typically a
 * <textarea> or a contenteditable inside a custom element. Selectors
 * are broad because the DOM changes frequently.
 */

import type { SiteAdapter } from "./types.js";

function firstMatch(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Copilot uses shadow DOM heavily. This helper pierces known shadow
 * roots to find the prompt input when direct selectors fail.
 */
function findInShadow(): HTMLElement | null {
  // Try known shadow-DOM host elements
  const hosts = document.querySelectorAll<HTMLElement>(
    "cib-serp, copilot-main, chat-input"
  );
  for (const host of hosts) {
    const root = host.shadowRoot;
    if (!root) continue;
    const input =
      root.querySelector<HTMLElement>("textarea") ??
      root.querySelector<HTMLElement>("div[contenteditable='true']");
    if (input) return input;
    // Recurse one level deeper
    const innerHosts = root.querySelectorAll<HTMLElement>("cib-action-bar, chat-text-input");
    for (const inner of innerHosts) {
      const innerRoot = inner.shadowRoot;
      if (!innerRoot) continue;
      const deepInput =
        innerRoot.querySelector<HTMLElement>("textarea") ??
        innerRoot.querySelector<HTMLElement>("div[contenteditable='true']");
      if (deepInput) return deepInput;
    }
  }
  return null;
}

export const copilotAdapter: SiteAdapter = {
  id: "copilot",
  label: "Copilot",

  matches: (hostname) =>
    hostname === "copilot.microsoft.com" ||
    hostname.endsWith(".copilot.microsoft.com") ||
    hostname === "www.bing.com",

  inputKind: "textarea",

  findInput: () => {
    // Try direct selectors first (non-shadow-DOM layouts)
    const direct = firstMatch([
      "textarea#user-input",
      "textarea[placeholder*='message' i]",
      "textarea[aria-label*='message' i]",
      "textarea[aria-label*='Ask' i]",
      "div[contenteditable='true'][role='textbox']",
    ]);
    if (direct) return direct;
    return findInShadow();
  },

  findSendButton: () =>
    firstMatch([
      "button[aria-label*='Send' i]",
      "button[aria-label*='Submit' i]",
      "button[title*='Send' i]",
    ]),

  readText: (input) => {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    return input.textContent ?? "";
  },
};
