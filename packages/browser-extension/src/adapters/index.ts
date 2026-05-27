/**
 * Site adapter registry.
 *
 * ───────────────────────────────────────────────────────────────────
 * TO ADD A NEW LLM SITE:
 *   1. Create `src/adapters/<site>.ts` exporting a SiteAdapter.
 *   2. Import it here and add it to the SITE_ADAPTERS array.
 *   3. Add its host to `host_permissions` and `content_scripts.matches`
 *      in manifest.json.
 * That is the entire change. No detection, UI, or interception code
 * is touched.
 * ───────────────────────────────────────────────────────────────────
 */

import type { SiteAdapter } from "./types.js";
import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { geminiAdapter } from "./gemini.js";
import { copilotAdapter } from "./copilot.js";
import { perplexityAdapter } from "./perplexity.js";
import { deepseekAdapter } from "./deepseek.js";
import { mistralAdapter } from "./mistral.js";
import { grokAdapter } from "./grok.js";
import { huggingchatAdapter } from "./huggingchat.js";
import { poeAdapter } from "./poe.js";
import { youAdapter } from "./you.js";
import { phindAdapter } from "./phind.js";
import { cohereAdapter } from "./cohere.js";

/** All registered adapters. Order matters only if matchers overlap. */
export const SITE_ADAPTERS: readonly SiteAdapter[] = [
  chatgptAdapter,
  claudeAdapter,
  geminiAdapter,
  copilotAdapter,
  perplexityAdapter,
  deepseekAdapter,
  mistralAdapter,
  grokAdapter,
  huggingchatAdapter,
  poeAdapter,
  youAdapter,
  phindAdapter,
  cohereAdapter,
];

/** Find the adapter for the current page, or null if unsupported. */
export function adapterFor(hostname: string): SiteAdapter | null {
  return SITE_ADAPTERS.find((a) => a.matches(hostname)) ?? null;
}

export type { SiteAdapter } from "./types.js";
export { readInputText } from "./types.js";
