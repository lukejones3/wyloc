/**
 * Popup script.
 *
 * Shows a local-only summary: how many secrets the extension has caught
 * on this machine, broken down by type. No account, no sign-in, no
 * network — reads straight from chrome.storage.local.
 */

import type { IncidentMetadata } from "@ai-dlp/detector";

const STORAGE_KEY = "ai-dlp/incidents";

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

async function main(): Promise<void> {
  render(await load());

  const clearBtn = document.getElementById("clear");
  clearBtn?.addEventListener("click", async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
    render([]);
  });
}

void main();
