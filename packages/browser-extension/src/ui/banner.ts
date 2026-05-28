/**
 * Inline warning banner.
 *
 * Rendered inside a Shadow DOM so the host LLM site's CSS cannot break
 * it and our CSS cannot leak into the host page. Two modes:
 *
 *   warn  — yellow banner, dismissable, submission still allowed.
 *   block — red banner, submission is held until the user explicitly
 *           chooses "Send anyway" (an informed override, never a hard
 *           lock — plan §7: heavy-handed blocking kills adoption).
 *
 * The banner shows finding TYPES and MASKED values only. The raw secret
 * is never written into the DOM we create.
 */

import type { ScanResult } from "@ai-dlp/detector";
import { maskValue } from "@ai-dlp/detector";

export interface BannerCallbacks {
  /** User chose to proceed despite findings (warn dismiss or block override). */
  onProceed: () => void;
  /** User chose to redact — replace secrets with placeholders in the input. */
  onRedact: () => void;
  /** User dismissed without action (warn only). */
  onDismiss: () => void;
}

const HOST_ID = "wyloc-banner-host";

/** Remove any existing banner. Safe to call when none exists. */
export function clearBanner(): void {
  document.getElementById(HOST_ID)?.remove();
}

/** Type-to-label map for human-readable banner text. */
const LABELS: Record<string, string> = {
  aws_access_key: "AWS access key",
  aws_secret_key: "AWS secret key",
  gcp_api_key: "GCP API key",
  gcp_service_account: "GCP service account key",
  azure_token: "Azure token",
  github_token: "GitHub token",
  gitlab_token: "GitLab token",
  slack_token: "Slack token",
  stripe_key: "Stripe key",
  openai_key: "OpenAI key",
  anthropic_key: "Anthropic key",
  jwt: "JWT",
  oauth_bearer: "OAuth bearer token",
  private_key: "private key",
  database_url: "database URL",
  generic_api_key: "API key",
  high_entropy_string: "possible secret",
  env_assignment: "credential assignment",
};

function labelFor(type: string): string {
  return LABELS[type] ?? "secret";
}

/**
 * Render the banner for a scan result. `mount` is the element the banner
 * is inserted before (typically the prompt input's container).
 */
export function showBanner(
  result: ScanResult,
  mount: HTMLElement,
  callbacks: BannerCallbacks,
): void {
  clearBanner();
  if (result.findings.length === 0) return;

  const isBlock = result.decision.action === "block";

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  // Build a concise, non-shaming finding list.
  const items = result.findings
    .map((f) => `${labelFor(f.type)} — ${maskValue(f.value)}`)
    .slice(0, 6);
  const extra = result.findings.length - items.length;

  const headline = isBlock
    ? "Hold on — this prompt contains a secret"
    : "Heads up — this prompt may contain a secret";
  const explainer = isBlock
    ? "Sending this would share a credential with an AI tool. Redact it, or send anyway if it's safe."
    : "Review before sending. You can redact it, or continue if it's fine.";

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        border-radius: 10px;
        padding: 12px 14px;
        margin: 8px 0;
        border: 1px solid ${isBlock ? "#e0b4b4" : "#e6d8a8"};
        background: ${isBlock ? "#fdf3f3" : "#fdfaef"};
        color: #2b2b2b;
        font-size: 13px;
        line-height: 1.45;
      }
      .head { font-weight: 600; margin-bottom: 4px; }
      .explain { color: #555; margin-bottom: 8px; }
      ul { margin: 0 0 10px; padding-left: 18px; }
      li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           font-size: 12px; color: #444; }
      .extra { color: #888; font-style: italic; }
      .row { display: flex; gap: 8px; }
      button {
        font: inherit; font-size: 12px; font-weight: 600;
        padding: 6px 12px; border-radius: 6px; cursor: pointer;
        border: 1px solid transparent;
      }
      .redact { background: #2f6f4f; color: #fff; }
      .redact:hover { background: #275f43; }
      .proceed {
        background: transparent;
        border-color: #bbb; color: #444;
      }
      .proceed:hover { background: #00000008; }
      .dismiss {
        background: transparent; border-color: transparent;
        color: #888; margin-left: auto;
      }
      .dismiss:hover { color: #444; }
    </style>
    <div class="wrap" role="alert">
      <div class="head">${headline}</div>
      <div class="explain">${explainer}</div>
      <ul>
        ${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}
        ${extra > 0 ? `<li class="extra">+${extra} more</li>` : ""}
      </ul>
      <div class="row">
        <button class="redact">Redact &amp; keep editing</button>
        <button class="proceed">${
          isBlock ? "Send anyway" : "Continue"
        }</button>
        ${
          isBlock
            ? ""
            : '<button class="dismiss">Dismiss</button>'
        }
      </div>
    </div>
  `;

  shadow
    .querySelector(".redact")
    ?.addEventListener("click", () => {
      clearBanner();
      callbacks.onRedact();
    });
  shadow
    .querySelector(".proceed")
    ?.addEventListener("click", () => {
      clearBanner();
      callbacks.onProceed();
    });
  shadow
    .querySelector(".dismiss")
    ?.addEventListener("click", () => {
      clearBanner();
      callbacks.onDismiss();
    });

  mount.parentElement?.insertBefore(host, mount);
}

/** Minimal HTML escape for the masked-value strings we render. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
