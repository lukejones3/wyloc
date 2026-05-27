/**
 * Content script — runs inside the LLM page.
 *
 * Responsibilities (plan §7):
 *   - Intercept submit (Enter keypress, send-button click).
 *   - Run local detection via @ai-dlp/detector.
 *   - On a finding: hold submission, show the inline banner.
 *   - Never scan in the background, never send telemetry, never force
 *     sign-in. The detector runs only on an explicit submit attempt.
 *
 * The bundler inlines @ai-dlp/detector into this file — no network,
 * no remote code, fully local enforcement.
 */

import { scan } from "@ai-dlp/detector";
import type { ScanResult } from "@ai-dlp/detector";
import { adapterFor, type SiteAdapter } from "./adapters/index.js";
import { showBanner, clearBanner } from "./ui/banner.js";
import { reportIncidents } from "./incident-bridge.js";

const adapter: SiteAdapter | null = adapterFor(location.hostname);

console.log(`%c[AI-DLP]%c adapter for "${location.hostname}":`, 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '', adapter ? adapter.id : 'NONE');

/**
 * When the user has reviewed a banner and chosen to proceed, we record
 * the exact text they approved. The next submit of that same text is
 * allowed straight through — otherwise the banner would re-fire and
 * trap them. Editing the prompt invalidates the approval.
 */
let approvedText: string | null = null;

/** Guards against re-entrant interception while a banner is open. */
let bannerOpen = false;

if (adapter) {
  console.log('%c[AI-DLP]%c installing interceptors…', 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '');
  installInterceptors(adapter);
}

function installInterceptors(site: SiteAdapter): void {
  // Capture-phase listeners so we see the event before the page's own
  // handlers and can stop submission if needed.
  document.addEventListener(
    "keydown",
    (e) => onKeydown(e, site),
    true,
  );
  document.addEventListener(
    "click",
    (e) => onClick(e, site),
    true,
  );
}

/** Enter (without Shift) in the prompt input is a submit attempt. */
function onKeydown(e: KeyboardEvent, site: SiteAdapter): void {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  console.log('%c[AI-DLP]%c Enter pressed', 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '');
  const input = site.findInput();
  if (!input) {
    console.log('%c[AI-DLP]%c findInput() returned null — cannot intercept', 'background:#c44;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '');
    return;
  }
  console.log('%c[AI-DLP]%c input found:', 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '', input.tagName, input.id || input.className);
  const target = e.target as Node | null;
  console.log('%c[AI-DLP]%c event target:', 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '', target?.nodeName, (target as HTMLElement)?.id || (target as HTMLElement)?.className);
  if (!eventTargetsInput(e, input)) {
    console.log('%c[AI-DLP]%c target not inside input — skipping', 'background:#c44;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '');
    return;
  }
  const text = site.readText(input);
  console.log('%c[AI-DLP]%c text length:', 'background:#2f6f4f;color:#fff;padding:1px 4px;border-radius:2px;font-weight:bold', '', text.length, '| first 60 chars:', JSON.stringify(text.slice(0, 60)));
  guardSubmit(e, site, input);
}

/** A click on the send button is also a submit attempt. */
function onClick(e: MouseEvent, site: SiteAdapter): void {
  const btn = site.findSendButton();
  if (!btn) return;
  const target = e.target as Node | null;
  if (!target || !(btn === target || btn.contains(target))) return;
  const input = site.findInput();
  if (!input) return;
  guardSubmit(e, site, input);
}

/** True if the event originated inside the prompt input element. */
function eventTargetsInput(e: Event, input: HTMLElement): boolean {
  const target = e.target as Node | null;
  return !!target && (input === target || input.contains(target));
}

/**
 * Core gate. Scans the current prompt text; if clean (or already
 * approved) the event proceeds untouched. Otherwise the event is
 * cancelled and the banner is shown.
 */
function guardSubmit(
  e: Event,
  site: SiteAdapter,
  input: HTMLElement,
): void {
  if (bannerOpen) {
    // A banner is already up — swallow stray submits until resolved.
    stop(e);
    return;
  }

  const text = site.readText(input);
  if (text.length === 0) return;

  // Previously approved this exact text — let it through once.
  if (approvedText !== null && approvedText === text) {
    approvedText = null;
    return;
  }

  const result: ScanResult = scan(text);
  if (result.findings.length === 0) {
    return; // clean — do not interfere
  }

  // Findings present: stop this submission and surface the banner.
  stop(e);
  bannerOpen = true;

  // Metadata-only incident reporting (fire-and-forget; never blocks UX).
  reportIncidents(result, site.id);

  showBanner(result, input, {
    onProceed: () => {
      bannerOpen = false;
      approvedText = text;
      resubmit(site, input);
    },
    onRedact: () => {
      bannerOpen = false;
      applyRedaction(site, input, result);
    },
    onDismiss: () => {
      bannerOpen = false;
    },
  });
}

/** Cancel an event as completely as the platform allows. */
function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

/**
 * After the user approves, re-trigger submission. We click the send
 * button when one exists (most reliable); otherwise dispatch a fresh
 * Enter keydown that our guard will now wave through via `approvedText`.
 */
function resubmit(site: SiteAdapter, input: HTMLElement): void {
  const btn = site.findSendButton();
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

/**
 * Replace detected secrets in the input with typed placeholders, in
 * place, then leave the cursor with the user to keep editing. We do not
 * auto-send after redaction — the user stays in control.
 */
function applyRedaction(
  site: SiteAdapter,
  input: HTMLElement,
  result: ScanResult,
): void {
  const original = site.readText(input);
  // Build the redacted string locally (detector's redact() logic, but
  // we re-derive here to keep the content script's DOM writes explicit).
  let redacted = original;
  const ordered = [...result.findings].sort((a, b) => b.start - a.start);
  for (const f of ordered) {
    const placeholder = `[REDACTED_${f.type.toUpperCase()}]`;
    redacted =
      redacted.slice(0, f.start) + placeholder + redacted.slice(f.end);
  }
  writeText(site, input, redacted);
  clearBanner();
}

/**
 * Write text back into the prompt input. textarea uses `.value`;
 * contenteditable needs its text replaced and an `input` event so the
 * site's framework (React/ProseMirror) registers the change.
 */
function writeText(
  site: SiteAdapter,
  input: HTMLElement,
  text: string,
): void {
  if (site.inputKind === "textarea") {
    (input as HTMLTextAreaElement).value = text;
  } else {
    input.textContent = text;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
