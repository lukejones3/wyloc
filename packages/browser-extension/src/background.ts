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

import type { IncidentMetadata } from "@ai-dlp/detector";

interface StoredIncident extends IncidentMetadata {
  siteId: string;
}

const STORAGE_KEY = "wyloc/incidents";
/** Cap local history so storage cannot grow without bound. */
const MAX_INCIDENTS = 500;

interface IncomingMessage {
  kind?: string;
  incidents?: IncidentMetadata[];
  siteId?: string;
}

chrome.runtime.onMessage.addListener((msg: IncomingMessage) => {
  if (msg?.kind !== "wyloc/incidents" || !Array.isArray(msg.incidents)) {
    return;
  }
  void persist(msg.incidents, msg.siteId ?? "unknown");
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
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  } catch {
    /* storage failure must not crash the worker */
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
