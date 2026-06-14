import type { CodeMaskerConfig } from "./config.js";
import { maskHost, maskPath, maskPrivateIp, maskToken } from "./mask.js";
import type { MaskKind } from "./types.js";

/** One substring replacement inside a string literal. */
export interface StringHit {
  real: string;
  mask: string;
  kind: MaskKind;
}

export interface StringMaskResult {
  value: string;
  hits: StringHit[];
}

const PRIVATE_IP =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

// A hostname-like token: two or more dot-separated labels. Lookarounds keep us
// from biting into a longer dotted token (e.g. a version string or a filename).
const HOSTNAME = /(?<![\w.-])(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+(?![\w.-])/g;

function endsWithDomain(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`));
}

/** The internal label (internal/corp/local…) present in a host, if any. */
function internalLabel(host: string, tlds: readonly string[]): string | null {
  const labels = host.toLowerCase().split(".");
  for (const t of tlds) if (labels.includes(t.toLowerCase())) return t;
  return null;
}

/**
 * Scan one string-literal value and mask internal infrastructure and gated
 * Bucket-2 references. Pure and deterministic. Replacements are applied so the
 * surrounding structure (scheme, path, query) is preserved — only the
 * proprietary host/ip/path/token is swapped.
 */
export function maskStringValue(value: string, cfg: CodeMaskerConfig): StringMaskResult {
  if (!cfg.maskStrings && !cfg.maskBucket2) return { value, hits: [] };
  const hits: StringHit[] = [];
  let out = value;

  const replaceAll = (re: RegExp, decide: (m: string) => string | null) => {
    out = out.replace(re, (m) => {
      const mask = decide(m);
      if (mask === null) return m;
      hits.push({ real: m, mask, kind: maskKindFor(m) });
      return mask;
    });
  };

  // Track kind per replacement; recomputed cheaply from which branch matched.
  let currentKind: MaskKind = "string";
  function maskKindFor(_m: string): MaskKind {
    return currentKind;
  }

  if (cfg.maskStrings) {
    // 1. Private IPs.
    if (cfg.maskPrivateIps) {
      currentKind = "string";
      replaceAll(PRIVATE_IP, (m) => maskPrivateIp(m, cfg));
    }
    // 2. Internal hostnames (internal-label anywhere, or under an org domain).
    currentKind = "string";
    replaceAll(HOSTNAME, (host) => {
      const label = internalLabel(host, cfg.internalTlds);
      if (label) return maskHost(host, label, cfg);
      if (endsWithDomain(host, cfg.internalDomains)) return maskHost(host, null, cfg);
      return null; // public host — leave it (the model may need it)
    });
    // 3. Architecture-revealing file paths.
    currentKind = "string";
    for (const re of cfg.internalPathPatterns) {
      replaceAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), (m) =>
        maskPath(m, cfg),
      );
    }
  }

  // 4. Bucket 2 — gated, conservative (off unless configured).
  if (cfg.maskBucket2) {
    currentKind = "string";
    for (const re of cfg.bucket2Patterns) {
      replaceAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), (m) =>
        maskToken(m, cfg),
      );
    }
    for (const sub of cfg.bucket2Substrings) {
      if (!sub) continue;
      const re = new RegExp(escapeRegex(sub), "gi");
      replaceAll(re, (m) => maskToken(m, cfg));
    }
  }

  return { value: out, hits };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
