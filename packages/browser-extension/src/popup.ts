/**
 * Popup script.
 *
 * Shows a local-only summary: how many secrets the extension has caught
 * on this machine, broken down by type. No account, no sign-in, no
 * network — reads straight from chrome.storage.local.
 */

import type { IncidentMetadata } from "@wyloc/detector";

const STORAGE_KEY = "wyloc/incidents";

interface StoredIncident extends IncidentMetadata {
  siteId: string;
}

const TYPE_LABELS: Record<string, string> = {
  aws_access_key: "AWS access key",
  aws_secret_key: "AWS secret key",
  gcp_api_key: "GCP API key",
  gcp_service_account: "GCP service account",
  azure_token: "Azure token",
  github_token: "GitHub token",
  gitlab_token: "GitLab token",
  slack_token: "Slack token",
  stripe_key: "Stripe key",
  openai_key: "OpenAI key",
  anthropic_key: "Anthropic key",
  jwt: "JWT",
  oauth_bearer: "OAuth bearer token",
  private_key: "Private key",
  database_url: "Database URL",
  generic_api_key: "API key",
  high_entropy_string: "Possible secret",
  env_assignment: "Credential assignment",
};

async function load(): Promise<StoredIncident[]> {
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    const val = obj[STORAGE_KEY];
    return Array.isArray(val) ? (val as StoredIncident[]) : [];
  } catch {
    return [];
  }
}

interface Mapping {
  mock: string;
  real: string;
}

/**
 * Pull the active tab's live mock→real mappings from its content script.
 * These are in-memory only (never in chrome.storage) and gone when the
 * tab closes, so we ask the page directly each time the popup opens. Any
 * failure (no content script on this tab, e.g. chrome:// pages) yields an
 * empty list — the section just stays hidden.
 */
async function loadMappings(): Promise<Mapping[]> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return [];
    const resp = (await chrome.tabs.sendMessage(
      tab.id,
      { kind: "wyloc/get-mappings" },
      { frameId: 0 },
    )) as { mappings?: Mapping[] } | undefined;
    const mappings = resp?.mappings;
    return Array.isArray(mappings) ? mappings : [];
  } catch {
    return [];
  }
}

function render(incidents: StoredIncident[]): void {
  const total = document.getElementById("total");
  const blocked = document.getElementById("blocked");
  const list = document.getElementById("breakdown");
  if (!total || !blocked || !list) return;

  total.textContent = String(incidents.length);
  blocked.textContent = String(
    incidents.filter((i) => i.action === "block").length,
  );

  const counts = new Map<string, number>();
  for (const i of incidents) {
    counts.set(i.secretType, (counts.get(i.secretType) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  list.innerHTML =
    sorted.length === 0
      ? '<li class="empty">Nothing caught yet — you\'re clean.</li>'
      : sorted
          .map(
            ([type, n]) =>
              `<li><span>${TYPE_LABELS[type] ?? type}</span><b>${n}</b></li>`,
          )
          .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the live mock→real mappings for the active tab. Real values are
 * the user's own secrets, shown only in this local popup so they can copy
 * one back when auto-rehydration missed it. Click a row to copy the real
 * value. Hidden entirely when there are no swaps in the tab.
 */
function renderMappings(mappings: Mapping[]): void {
  const section = document.getElementById("mappings-section");
  const list = document.getElementById("mappings");
  if (!section || !list) return;

  if (mappings.length === 0) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  list.innerHTML = mappings
    .map(
      (m) =>
        `<li class="map" data-real="${escapeHtml(m.real)}" title="Click to copy the real value">` +
        `<code class="mock">${escapeHtml(m.mock)}</code>` +
        `<code class="real">${escapeHtml(m.real)}</code>` +
        `</li>`,
    )
    .join("");

  for (const li of Array.from(list.querySelectorAll<HTMLLIElement>("li.map"))) {
    li.addEventListener("click", () => {
      const real = li.getAttribute("data-real") ?? "";
      void navigator.clipboard.writeText(real).then(() => {
        li.classList.add("copied");
        setTimeout(() => li.classList.remove("copied"), 1000);
      });
    });
  }
}

async function main(): Promise<void> {
  render(await load());
  renderMappings(await loadMappings());

  const clearBtn = document.getElementById("clear");
  clearBtn?.addEventListener("click", async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
    render([]);
  });
}

void main();
