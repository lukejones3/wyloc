/**
 * Background service worker.
 *
 * V3 scope: receives metadata-only incident records from content
 * scripts and stores them in `chrome.storage.local`. No network, no
 * central plane yet (plan §10 marks the control plane optional / later).
 *
 * Everything stored here is `IncidentMetadata` — already free of prompt
 * text and secret values by construction in the detector.
 */

import type { IncidentMetadata } from "@wyloc/detector";

interface StoredIncident extends IncidentMetadata {
  siteId: string;
}

const STORAGE_KEY = "wyloc/incidents";
/** Cap local history so storage cannot grow without bound. */
const MAX_INCIDENTS = 500;

// Set to false before store submission.
const DEBUG = true;

interface IncomingMessage {
  kind?: string;
  incidents?: IncidentMetadata[];
  siteId?: string;
}

// On install or update, inject content scripts into already-open tabs.
// Tabs opened before install/update never receive the manifest-declared
// content scripts (those only run on fresh page loads), so we inject
// programmatically here. The content script itself guards against
// double-injection via window.__wylocContentInjected.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    if (DEBUG) console.debug("[wyloc] onInstalled: tabs.query failed", err);
    return;
  }

  let injected = 0;
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;

    // Only inject into http/https tabs. chrome://, chrome-extension://,
    // about:, and the Web Store all throw on scripting injection.
    let protocol: string;
    try {
      protocol = new URL(tab.url).protocol;
    } catch {
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") continue;

    // CSS must be present before the content script runs so the banner renders.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    } catch { /* tab may have navigated or be in an ineligible state */ }

    // Isolated-world content script (detection + banner).
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      injected++;
    } catch { /* fail silently — don't break the loop */ }

    // MAIN-world clipboard proxy (intercepts navigator.clipboard.writeText).
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"], world: "MAIN" });
    } catch { /* fail silently */ }
  }

  if (DEBUG) console.debug(`[wyloc] onInstalled(${details.reason}): injected into ${injected} tab(s)`);
});

// Async listener: returning a Promise tells Chrome's MV3 runtime to keep
// the service worker alive until the Promise settles, so the two sequential
// storage awaits inside persist() are guaranteed to complete before the
// worker is suspended. A synchronous listener returning undefined would
// let Chrome terminate the worker before the write finishes.
chrome.runtime.onMessage.addListener(async (msg: IncomingMessage) => {
  if (msg?.kind !== "wyloc/incidents" || !Array.isArray(msg.incidents)) {
    return;
  }
  if (DEBUG) console.debug("[wyloc] background: received", msg.incidents.length, "incident(s) from", msg.siteId);
  await persist(msg.incidents, msg.siteId ?? "unknown");
});

async function persist(
  incidents: IncidentMetadata[],
  siteId: string,
): Promise<void> {
  try {
    const existing = await readAll();
    const tagged: StoredIncident[] = incidents.map((i) => ({
      ...i,
      siteId,
    }));
    const merged = [...existing, ...tagged].slice(-MAX_INCIDENTS);
    if (DEBUG) console.debug("[wyloc] background: writing", merged.length, "total incident(s) to storage");
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    if (DEBUG) console.debug("[wyloc] background: storage write complete");
  } catch (err) {
    if (DEBUG) console.debug("[wyloc] background: persist failed", err);
  }
}

async function readAll(): Promise<StoredIncident[]> {
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    const val = obj[STORAGE_KEY];
    return Array.isArray(val) ? (val as StoredIncident[]) : [];
  } catch {
    return [];
  }
}
