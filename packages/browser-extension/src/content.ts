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
import type { ScanResult, SwapMapping } from "@wyloc/detector";
import { buildSwap } from "@wyloc/detector";
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

// "Send anyway" support. Rather than synthetically re-triggering submit
// (unreliable across SPAs), we arm a one-shot bypass: after the user
// clicks "Send anyway", the next genuine submit of that same text is let
// through untouched. The user presses Enter / clicks send themselves,
// which uses the site's real submit path.
let proceedArmed = false;
let proceedText = "";
let proceedAt = 0;

// Backstop only. The primary disarm is text divergence from proceedText
// (see isProceedApproved); this window just guarantees an approval can
// never permanently disable detection. It must comfortably cover the full
// event burst for one submit plus the user's click on the real send
// button — both happen within a fraction of a second of arming.
const PROCEED_WINDOW_MS = 15_000;

// ── Dummy-swap session state (ephemeral, never persisted) ──────────
//
// The salt is generated once per page load and lives only in this
// content script's memory. It is used to derive deterministic mocks so
// repeated secrets in one prompt collapse to one consistent mock.
//
// `swapMappings` holds the real↔mock pairs for the current session so
// we can rehydrate the LLM's response on copy-out. It is wiped on page
// unload. Raw secret values live here in memory only — never written to
// chrome.storage, never sent anywhere.
const sessionSalt: string = generateSalt();
let swapMappings: SwapMapping[] = [];

function generateSalt(): string {
  // crypto.getRandomValues is available in content-script context.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Wipe the mapping store when the tab/page goes away (memory hygiene —
// engineering doc §3: session-scoped ephemeral storage).
window.addEventListener("pagehide", () => {
  swapMappings = [];
});
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

  // "Send anyway" was clicked: let this submit through untouched while the
  // approval still applies. Must NOT be consumed on first match — a single
  // user submit fires several of our listeners (document capture + direct
  // element listeners, plus beforeinput on contenteditable), each calling
  // guardSubmit with the same text. Disarming here would let the next
  // listener re-detect and re-block. See isProceedApproved.
  if (isProceedApproved(text)) return;

  if (approvedText !== null && approvedText === text) {
    approvedText = null;
    return;
  }

  const result: ScanResult = scan(text);
  if (result.findings.length === 0) return;

  // If every finding is one of our own swap mocks, the text is already
  // safe — let it through without re-prompting. This is more robust than
  // exact-text matching, which breaks when the site normalizes
  // whitespace/newlines in a contenteditable after we write to it.
  if (
    swapMappings.length > 0 &&
    result.findings.every((f) =>
      swapMappings.some((m) => m.mock === f.value),
    )
  ) {
    return;
  }

  stop(e);
  bannerOpen = true;

  reportIncidents(result, adapter.id);

  showBanner(result, input, {
    onProceed: () => {
      bannerOpen = false;
      // Don't try to re-trigger submission programmatically — synthetic
      // submit is unreliable across React SPAs (Claude/Gemini render the
      // real send button conditionally and ignore synthetic Enter). The
      // robust path: stop blocking and let the user press Enter / click
      // send themselves. We arm a bypass so that the next genuine submit
      // of this same text passes straight through without re-prompting.
      proceedArmed = true;
      proceedText = readText(input);
      proceedAt = Date.now();
    },
    onSwap: () => {
      bannerOpen = false;
      applySwap(input, result);
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

/**
 * One-shot "Send anyway" approval check, consulted by guardSubmit on
 * EVERY submit path before scan() runs. Returns true when the current
 * submit should bypass detection because the user just approved this
 * exact text.
 *
 * It deliberately does NOT disarm on a match. A single user submit fires
 * multiple of our listeners (document-capture keydown/click + the direct
 * element listeners, plus a beforeinput on contenteditable), each calling
 * guardSubmit with the same text within the same instant. Consuming the
 * approval on the first match would leave proceedArmed=false for the next
 * listener, which would then re-detect and re-block. Instead we disarm
 * only when the approval no longer applies:
 *   - the text diverged from what was approved (user edited it → protection
 *     re-arms automatically; this is the primary guard), or
 *   - the time window lapsed (a backstop so detection can never be left
 *     permanently disabled).
 * Tolerant trim() compare so trailing-newline normalization in a
 * contenteditable doesn't defeat the match.
 */
function isProceedApproved(text: string): boolean {
  if (!proceedArmed) return false;
  if (text.trim() !== proceedText.trim()) {
    disarmProceed();
    return false;
  }
  if (Date.now() - proceedAt > PROCEED_WINDOW_MS) {
    disarmProceed();
    return false;
  }
  return true;
}

function disarmProceed(): void {
  proceedArmed = false;
  proceedText = "";
  proceedAt = 0;
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
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

/**
 * Swap secrets for structurally-valid mocks, store the mapping for
 * rehydration, write the swapped text back into the input, then send.
 *
 * Unlike redaction (which destroys the secret's structure), the model
 * receives shape-valid stand-ins and keeps full reasoning ability. When
 * the user copies the model's reply, `installCopyRehydration` swaps the
 * real values back in.
 */
function applySwap(input: HTMLElement, result: ScanResult): void {
  const original = readText(input);
  const { swappedText, mappings } = buildSwap(
    original,
    result.findings,
    sessionSalt,
  );

  // Merge new mappings into the session store, deduped by mock.
  const seen = new Set(swapMappings.map((m) => m.mock));
  for (const m of mappings) {
    if (!seen.has(m.mock)) {
      swapMappings.push(m);
      seen.add(m.mock);
    }
  }

  writeText(input, swappedText);
  clearBanner();

  // Option A: do NOT auto-send. The user sees the swapped prompt (their
  // secret is now a safe stand-in) and presses send themselves. This
  // keeps the developer in control at the moment of submission and
  // avoids fragile programmatic-send behavior across React-controlled
  // inputs. When they do send, guardSubmit recognizes the mocks as
  // already-safe and lets the text through without re-prompting.
}

// ── Copy-out rehydration ───────────────────────────────────────────
//
// When the user copies text that contains our mock tokens (typically
// the model's response), we replace the mocks with the real values so
// the developer gets working output back.
//
// Two interception paths, because sites copy in two different ways:
//   1. Native `copy` DOM event — plain selection + Cmd/Ctrl+C.
//   2. `navigator.clipboard.writeText()` — what SPAs like ChatGPT use
//      for their code-block copy buttons and sometimes for Cmd+C inside
//      a code block. This call happens in the page's MAIN world and is
//      invisible to an isolated-world DOM listener, so a small proxy
//      injected into the main world forwards the text to us here.
installCopyRehydration();
installClipboardProxyBridge();

function installCopyRehydration(): void {
  document.addEventListener(
    "copy",
    (e: ClipboardEvent) => {
      if (swapMappings.length === 0) return;
      const selection = window.getSelection?.()?.toString() ?? "";
      if (selection.length === 0) return;

      const rehydrated = rehydrateSmart(selection);
      if (rehydrated === selection) return; // no mocks present

      e.clipboardData?.setData("text/plain", rehydrated);
      e.preventDefault();
    },
    true,
  );
}

/**
 * Bridge for the main-world clipboard proxy (see inject.ts). The proxy
 * dispatches `WylocCheckRehydration` with the text the page is about to
 * write; we rehydrate and dispatch `WylocTextProcessed` back.
 */
function installClipboardProxyBridge(): void {
  window.addEventListener("WylocCheckRehydration", (e: Event) => {
    const ce = e as CustomEvent<{ id: string; text: string }>;
    const id = ce.detail?.id;
    const text = ce.detail?.text ?? "";
    const out = swapMappings.length > 0 ? rehydrateSmart(text) : text;
    window.dispatchEvent(
      new CustomEvent("WylocTextProcessed", { detail: { id, text: out } }),
    );
  });
}

/**
 * Rehydrate with semantic awareness. A blunt find-replace breaks when a
 * model uses the mock as an IDENTIFIER rather than a value, e.g.
 * `os.environ["WYLOC_MOCK_AWS_ACCESS_KEY_X"]` would wrongly become
 * `os.environ["AKIA..."]` (real key as a variable name). When we detect
 * a mock sitting in identifier position, we leave it in place rather
 * than corrupt the code; otherwise we swap the real value in.
 */
function rehydrateSmart(text: string): string {
  let result = text;
  for (const m of swapMappings) {
    if (!m.mock) continue;
    // Find each occurrence and decide per-occurrence whether it's an
    // identifier context (skip) or a value context (replace).
    let idx = result.indexOf(m.mock);
    while (idx !== -1) {
      const before = result.slice(Math.max(0, idx - 16), idx);
      const after = result.slice(idx + m.mock.length, idx + m.mock.length + 4);
      const isIdentifier =
        /(?:environ|getenv|process\.env|env)\s*[\[.]\s*['"]?$/.test(before) ||
        /process\.env\.$/.test(before) ||
        // mock used as a bare property/var name (no quote before, no quote after)
        (/[.\[]\s*$/.test(before) && !/^['"]/.test(after));

      if (isIdentifier) {
        // Skip this occurrence; advance past it.
        idx = result.indexOf(m.mock, idx + m.mock.length);
      } else {
        result =
          result.slice(0, idx) + m.real + result.slice(idx + m.mock.length);
        idx = result.indexOf(m.mock, idx + m.real.length);
      }
    }
  }
  return result;
}

function writeText(input: HTMLElement, text: string): void {
  if (
    input instanceof HTMLTextAreaElement ||
    input instanceof HTMLInputElement
  ) {
    // Setting .value directly bypasses React's value tracker, so React
    // never sees the change and leaves the send button disabled. Use the
    // native prototype setter, which React's tracker hooks, then dispatch
    // a real InputEvent so the framework's onChange/onInput fires.
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(input, text);
    } else {
      input.value = text;
    }
  } else {
    // Contenteditable: replace text content.
    input.textContent = text;
  }

  // Fire a proper InputEvent (not a bare Event) so React/Angular/Vue
  // listeners treat this as genuine user input and re-enable controls
  // like the send button.
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text,
    }),
  );
}
