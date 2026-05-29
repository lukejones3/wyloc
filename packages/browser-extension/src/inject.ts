/**
 * Main-world clipboard proxy.
 *
 * This script runs in the PAGE's execution context (the "MAIN" world),
 * not the extension's isolated world. That distinction is the whole
 * point: SPAs like ChatGPT capture Cmd+C inside their code blocks and
 * push formatted text to the OS clipboard via
 * `navigator.clipboard.writeText()` — a call our isolated-world content
 * script can neither see nor intercept with a DOM `copy` listener.
 *
 * By proxying `navigator.clipboard.writeText` here in the main world, we
 * see the exact text the page is about to write, hand it to the isolated
 * world for rehydration (mock → real value), and write back the result.
 *
 * Communication crosses the world boundary via CustomEvents on `window`,
 * which both worlds share. No secrets live in this script; it only
 * forwards text and awaits the processed version.
 */

(function installClipboardProxy() {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  // Guard against double-injection.
  if ((window as unknown as { __wylocClipboardProxy?: boolean })
    .__wylocClipboardProxy) {
    return;
  }
  (window as unknown as { __wylocClipboardProxy?: boolean })
    .__wylocClipboardProxy = true;

  const original = navigator.clipboard.writeText.bind(navigator.clipboard);

  navigator.clipboard.writeText = function (text: string): Promise<void> {
    // Fast path: nothing to do if not a string.
    if (typeof text !== "string" || text.length === 0) {
      return original(text);
    }

    return new Promise<void>((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      let settled = false;

      const onProcessed = (e: Event) => {
        const ce = e as CustomEvent<{ id: string; text: string }>;
        if (ce.detail?.id !== id) return;
        cleanup();
        original(ce.detail.text).then(resolve, reject);
      };

      const cleanup = () => {
        settled = true;
        window.removeEventListener("WylocTextProcessed", onProcessed);
      };

      window.addEventListener("WylocTextProcessed", onProcessed);

      // Ask the isolated world to rehydrate.
      window.dispatchEvent(
        new CustomEvent("WylocCheckRehydration", { detail: { id, text } }),
      );

      // Safety: if the isolated world doesn't answer quickly (e.g. no
      // mappings, or content script not present), fall back to writing
      // the original text so copy never silently breaks.
      setTimeout(() => {
        if (settled) return;
        cleanup();
        original(text).then(resolve, reject);
      }, 50);
    });
  };
})();
