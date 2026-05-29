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
 * Communication crosses the world boundary via `window.postMessage`.
 * A `CustomEvent.detail` created in the isolated world is NOT readable
 * from this main world (the page cannot reach into content-script
 * objects), so the bridge's reply must use postMessage, which
 * structured-clones its payload and therefore crosses the boundary in
 * both directions. No secrets live in this script; it only forwards text
 * and awaits the processed version.
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

      const onMessage = (e: MessageEvent) => {
        // Only accept our own reply from this same window/origin.
        if (e.source !== window || e.origin !== window.location.origin) return;
        const d = e.data as
          | { __wyloc?: string; id?: string; text?: string }
          | null;
        if (!d || d.__wyloc !== "processed" || d.id !== id) return;
        cleanup();
        original(d.text ?? text).then(resolve, reject);
      };

      const cleanup = () => {
        settled = true;
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);

      // Ask the isolated world to rehydrate. Self-targeted postMessage is
      // delivered only to listeners on THIS window (not other frames), so
      // the secret-bearing reply never leaves this frame; the receive guard
      // above re-validates source and origin regardless.
      window.postMessage({ __wyloc: "check", id, text }, "*");

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
