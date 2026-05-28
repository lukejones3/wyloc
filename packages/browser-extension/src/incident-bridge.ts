/**
 * Incident bridge.
 *
 * Converts a scan result into metadata-only incident records and hands
 * them to the background service worker. The content script never does
 * network I/O itself — it only passes safe metadata over the extension
 * message channel.
 *
 * Critical invariant: what crosses this boundary is `IncidentMetadata`
 * (no prompt text, no secret value), produced by the detector's own
 * `buildIncidents`. The raw `ScanResult.findings[].value` never leaves
 * the content script.
 */

import type { ScanResult } from "@wyloc/detector";
import { buildIncidents } from "@wyloc/detector";

export interface IncidentMessage {
  kind: "ai-dlp/incidents";
  incidents: ReturnType<typeof buildIncidents>;
}

/**
 * Fire-and-forget: build incidents and post them to the background
 * worker. Any failure is swallowed — incident logging must never
 * interrupt or delay the user.
 */
export function reportIncidents(result: ScanResult, siteId: string): void {
  try {
    const incidents = buildIncidents(
      result.findings,
      result.decision.perFinding,
      "browser",
    );
    if (incidents.length === 0) return;

    // siteId is attached as adapter context; it is not a secret.
    const message: IncidentMessage & { siteId: string } = {
      kind: "ai-dlp/incidents",
      incidents,
      siteId,
    };
    chrome.runtime.sendMessage(message).catch(() => {
      /* background worker asleep or unavailable — ignore */
    });
  } catch {
    /* never let incident logging affect the page */
  }
}
