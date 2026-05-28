/**
 * Content script — universal prompt-time DLP.
 *
 * Runs on EVERY page. Finds any active text input (textarea or
 * contenteditable), intercepts submission (Enter / beforeinput /
 * send-button click), scans for secrets, and shows a banner if any
 * are found.
 *
 * Site-specific adapters are optional precision overrides for known
 * LLM sites where we know the exact DOM. If an adapter matches, its
 * selectors are used. Otherwise the universal finder kicks in.
 *
 * The extension is invisible unless a secret is actually detected.
 * No background scanning, no telemetry, no forced sign-in.
 */

import { scan } from "@wyloc/detector";
import type { ScanResult } from "@wyloc/detector";
import { adapterFor, type SiteAdapter } from "./adapters/index.js";
import { showBanner, clearBanner } from "./ui/banner.js";
import { reportIncidents } from "./incident-bridge.js";

// ── Adapter or universal mode ──────────────────────────────────────

const siteAdapter: SiteAdapter | null = adapterFor(location.hostname);

/**
 * Universal adapter — works on any page. Used as the fallback when
 * no site-specific adapter matches. Finds any textarea or
 * contenteditable currently on the page.
 */
const universalAdapter: SiteAdapter = {
  id: location.hostname,
  label: location.hostname,
  matches: () => true,
  inputKind: "contenteditable",

  findInput: () => {
    // Prefer the currently focused element if it's an input.
    const active = document.activeElement as HTMLElement | null;
    if (active) {
      if (active instanceof HTMLTextAreaElement) return active;
      if (active.isContentEditable) return active;
    }
    // Fallback: find the most prominent input on the page.
    // Prefer contenteditable (most LLM chats) over textarea.
    return (
      document.querySelector<HTMLElement>(
        "div[contenteditable='true'][role='textbox']"
      ) ??
      document.querySelector<HTMLElement>(
        "div[contenteditable='true'].ProseMirror"
      ) ??
      document.querySelector<HTMLElement>(
        "div[contenteditable='true'].ql-editor"
      ) ??
      document.querySelector<HTMLElement>(
        "div[contenteditable='true']"
      ) ??
      document.querySelector<HTMLElement>("textarea") ??
      null
    );
  },

  findSendButton: () =>
    document.querySelector<HTMLElement>(
      "button[aria-label*='Send' i]"
    ) ??
    document.querySelector<HTMLElement>(
      "button[aria-label*='Submit' i]"
    ) ??
    document.querySelector<HTMLElement>(
      "button[type='submit']"
    ) ??
    null,

  readText: (input: HTMLElement): string => {
    if (input instanceof HTMLTextAreaElement) return input.value;
    if (input instanceof HTMLInputElement) return input.value;
    // Contenteditable: join child blocks with newlines.
    const blocks = input.querySelectorAll<HTMLElement>(":scope > *");
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((b) => b.textContent ?? "")
        .join("\n");
    }
    return input.textContent ?? "";
  },
};

/** The active adapter — site-specific if matched, universal otherwise. */
const adapter: SiteAdapter = siteAdapter ?? universalAdapter;

// ── State ──────────────────────────────────────────────────────────

let approvedText: string | null = null;
let bannerOpen = false;

/** Elements we've directly attached listeners to. */
let attachedInput: HTMLElement | null = null;
let attachedSendBtn: HTMLElement | null = null;

// ── Bootstrap ──────────────────────────────────────────────────────

installDocumentInterceptors();
installObserver();

// ── Mode A: document-level capture ─────────────────────────────────

function installDocumentInterceptors(): void {
  document.addEventListener("keydown", onDocKeydown, true);
  document.addEventListener("click", onDocClick, true);
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  const input = findActiveInput(e);
  if (!input) return;
  guardSubmit(e, input);
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  // Check if click is on or inside a send button.
  const btn = adapter.findSendButton();
  if (!btn) return;
  if (!(btn === target || btn.contains(target))) return;
  const input = adapter.findInput();
  if (!input) return;
  guardSubmit(e, input);
}

/**
 * Find the input element for a keydown event. If an adapter exists,
 * use its finder; otherwise check if the event target is itself an
 * input or is inside one.
 */
function findActiveInput(e: KeyboardEvent): HTMLElement | null {
  // Adapter-specific finder first.
  const adapterInput = adapter.findInput();
  if (adapterInput) {
    const target = e.target as Node | null;
    if (target && (adapterInput === target || adapterInput.contains(target))) {
      return adapterInput;
    }
  }
  // Universal: is the event target itself a text input?
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target.isContentEditable) return findEditableRoot(target);
  return null;
}

/**
 * Walk up from a contenteditable node to find the root editable
 * element (the one with contenteditable="true" directly set).
 */
function findEditableRoot(el: HTMLElement): HTMLElement {
  let node: HTMLElement = el;
  while (node.parentElement?.isContentEditable) {
    node = node.parentElement;
  }
  return node;
}

// ── Mode B: direct-attach via MutationObserver ─────────────────────

function installObserver(): void {
  tryAttach();
  const observer = new MutationObserver(() => tryAttach());
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function tryAttach(): void {
  const input = adapter.findInput();
  if (input && input !== attachedInput) {
    detachInput();
    attachedInput = input;
    input.addEventListener("keydown", directKeydown, true);
    input.addEventListener("beforeinput", directBeforeInput, true);
  }

  const btn = adapter.findSendButton();
  if (btn && btn !== attachedSendBtn) {
    detachSendBtn();
    attachedSendBtn = btn;
    btn.addEventListener("click", directSendClick, true);
  }
}

function detachInput(): void {
  if (!attachedInput) return;
  attachedInput.removeEventListener("keydown", directKeydown, true);
  attachedInput.removeEventListener("beforeinput", directBeforeInput, true);
  attachedInput = null;
}

function detachSendBtn(): void {
  if (!attachedSendBtn) return;
  attachedSendBtn.removeEventListener("click", directSendClick, true);
  attachedSendBtn = null;
}

function directKeydown(e: Event): void {
  if (!(e instanceof KeyboardEvent)) return;
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  const input = attachedInput ?? adapter.findInput();
  if (!input) return;
  guardSubmit(e, input);
}

function directBeforeInput(e: Event): void {
  if (!(e instanceof InputEvent)) return;
  if (e.inputType !== "insertParagraph") return;
  const input = attachedInput ?? adapter.findInput();
  if (!input) return;
  guardSubmit(e, input);
}

function directSendClick(e: Event): void {
  const input = attachedInput ?? adapter.findInput();
  if (!input) return;
  guardSubmit(e, input);
}

// ── Shared gate ────────────────────────────────────────────────────

function readText(input: HTMLElement): string {
  return adapter.readText(input);
}

function guardSubmit(e: Event, input: HTMLElement): void {
  if (bannerOpen) {
    stop(e);
    return;
  }

  const text = readText(input);
  if (text.length === 0) return;

  if (approvedText !== null && approvedText === text) {
    approvedText = null;
    return;
  }

  const result: ScanResult = scan(text);
  if (result.findings.length === 0) return;

  stop(e);
  bannerOpen = true;

  reportIncidents(result, adapter.id);

  showBanner(result, input, {
    onProceed: () => {
      bannerOpen = false;
      approvedText = text;
      resubmit(input);
    },
    onRedact: () => {
      bannerOpen = false;
      applyRedaction(input, result);
    },
    onDismiss: () => {
      bannerOpen = false;
    },
  });
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function resubmit(input: HTMLElement): void {
  const btn = adapter.findSendButton();
  if (btn) {
    btn.click();
    return;
  }
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function applyRedaction(input: HTMLElement, result: ScanResult): void {
  const original = readText(input);
  let redacted = original;
  const ordered = [...result.findings].sort((a, b) => b.start - a.start);
  for (const f of ordered) {
    const placeholder = `[REDACTED_${f.type.toUpperCase()}]`;
    redacted =
      redacted.slice(0, f.start) + placeholder + redacted.slice(f.end);
  }
  writeText(input, redacted);
  clearBanner();
}

function writeText(input: HTMLElement, text: string): void {
  if (input instanceof HTMLTextAreaElement) {
    (input as HTMLTextAreaElement).value = text;
  } else if (input instanceof HTMLInputElement) {
    (input as HTMLInputElement).value = text;
  } else {
    input.textContent = text;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
