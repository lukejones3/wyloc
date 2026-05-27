/**
 * Site adapter contract.
 *
 * Each supported LLM site is described by ONE `SiteAdapter` object.
 * Adding a new site (Gemini, Copilot, ...) means appending one adapter
 * to the registry in `index.ts` — no changes to detection, UI, or the
 * interception logic. This is the seam that keeps "support another
 * site" a small, isolated change.
 */

/**
 * How a site exposes its prompt input. LLM sites differ here: some use a
 * real <textarea>, others a contenteditable <div> (ChatGPT, Claude).
 */
export type InputKind = "textarea" | "contenteditable";

export interface SiteAdapter {
  /** Stable identifier, e.g. "chatgpt". Used in incident metadata. */
  id: string;
  /** Human-readable name for UI. */
  label: string;
  /**
   * Returns true if this adapter handles the current page. Checked
   * against `location.hostname`.
   */
  matches: (hostname: string) => boolean;
  /** Whether the prompt input is a textarea or a contenteditable node. */
  inputKind: InputKind;
  /**
   * Locate the prompt input element currently on the page. LLM sites
   * are SPAs and re-render constantly, so this is called fresh each
   * time rather than cached. Returns null if not present yet.
   */
  findInput: () => HTMLElement | null;
  /**
   * Locate the send/submit button, if the site has one. Used so the
   * extension can intercept click-to-send in addition to Enter.
   * Returns null if not found or not applicable.
   */
  findSendButton: () => HTMLElement | null;
  /**
   * Read the current prompt text from an input element. Abstracted
   * because textarea uses `.value` and contenteditable uses
   * `.textContent`.
   */
  readText: (input: HTMLElement) => string;
}

/** Extract plain text from any supported input element. */
export function readInputText(
  adapter: SiteAdapter,
  input: HTMLElement,
): string {
  return adapter.readText(input);
}
