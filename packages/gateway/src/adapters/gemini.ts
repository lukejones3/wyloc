/**
 * Google Gemini API (`/v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent`) adapter — the wire format the Gemini CLI speaks.
 *
 * Structurally different again from Chat Completions / Responses (Phase-2 map):
 *   • system prompt   → top-level `systemInstruction` (a Content: `{parts:[…]}`).
 *                       Some clients send snake_case `system_instruction`.
 *   • user/history    → `contents[]`, each a Content `{role, parts[]}`.
 *   • message text    → `parts[].text` (a part holds EXACTLY ONE of text /
 *                       functionCall / functionResponse / inlineData / fileData).
 *   • tool results    → `parts[].functionResponse.response` — an arbitrary JSON
 *                       object (the tool's return value; where the CLI's read
 *                       file content lands). The file-read equivalent of Chat's
 *                       role:"tool" / Responses' function_call_output.
 *   • tool calls      → `parts[].functionCall` (name + args) and
 *                       `tools[].functionDeclarations` — left byte-intact.
 *   • binary          → `inlineData` / `fileData` — never touched.
 *
 * Like every adapter this carries NO masking logic; it only tells the shared
 * engine WHICH strings are maskable and where the directive goes. Masking a
 * part's `text` naturally skips functionCall/functionResponse/inlineData parts
 * (they have no string `.text`), so the tool-call ENVELOPE is never disturbed.
 * `forEachToolResultText` feeds the SAME file-read content-router as the other
 * adapters (detector always, SQL/code/env on sniff+toggle).
 */
import type { MockMapping } from "../session.js";
import { WYLOC_DIRECTIVE } from "../directive.js";
import { rehydrateGeminiStream } from "../sse-rehydrate-gemini.js";
import type { ProviderAdapter, TextVisitor } from "./types.js";

interface Part { text?: unknown; functionResponse?: unknown }
interface Content { role?: unknown; parts?: unknown }

/** Mask the `text` of every text-bearing part in a Content's `parts[]`. */
async function maskParts(content: unknown, visit: TextVisitor): Promise<void> {
  if (content === null || typeof content !== "object") return;
  const parts = (content as Content).parts;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (part !== null && typeof part === "object" && typeof (part as Part).text === "string") {
      (part as { text: string }).text = await visit((part as { text: string }).text);
    }
    // functionCall / functionResponse / inlineData / fileData parts: no `.text`,
    // so they are never matched here — envelope stays intact.
  }
}

/** Recursively replace every STRING leaf under a tool-result `response` object
 *  via `visit`. The response is freeform JSON (the tool decides its keys), so we
 *  mask all its string values — keys and structure are untouched. Over-applying
 *  the content-router to a non-secret string is safe (swap+rehydrate / no-op). */
async function maskStringsDeep(node: unknown, visit: TextVisitor): Promise<void> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") node[i] = await visit(v);
      else if (v !== null && typeof v === "object") await maskStringsDeep(v, visit);
    }
  } else if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") obj[k] = await visit(v);
      else if (v !== null && typeof v === "object") await maskStringsDeep(v, visit);
    }
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  constructor(readonly defaultUpstreamBaseUrl: string) {}

  /**
   * Rewrite every prose-bearing field: `systemInstruction` (or snake_case
   * `system_instruction`) parts, and each `contents[]` message's text parts.
   * functionCall / functionResponse / inlineData parts are not matched (no
   * `.text`); tool-result CONTENT is handled by forEachToolResultText so it
   * flows through the file-read router.
   */
  async forEachText(body: unknown, visit: TextVisitor): Promise<void> {
    if (body === null || typeof body !== "object") return;
    const obj = body as { systemInstruction?: unknown; system_instruction?: unknown; contents?: unknown };

    await maskParts(obj.systemInstruction, visit);
    await maskParts(obj.system_instruction, visit);

    if (Array.isArray(obj.contents)) {
      for (const content of obj.contents) await maskParts(content, visit);
    }
  }

  /**
   * Rewrite the CONTENT of every `functionResponse.response` (the result a
   * tool / file-read returned — where the CLI's read file content lands). The
   * `response` is an arbitrary JSON object, so we mask its string leaves
   * recursively. `functionResponse.name`/`id` (the envelope) and functionCall
   * args are never touched. Routed through the same content-router as the
   * other adapters' tool results.
   */
  async forEachToolResultText(body: unknown, visit: TextVisitor): Promise<void> {
    if (body === null || typeof body !== "object") return;
    const obj = body as { contents?: unknown };
    if (!Array.isArray(obj.contents)) return;
    for (const content of obj.contents) {
      if (content === null || typeof content !== "object") continue;
      const parts = (content as Content).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const fr = (part as Part).functionResponse;
        if (fr === null || typeof fr !== "object") continue;
        await maskStringsDeep((fr as { response?: unknown }).response, visit);
      }
    }
  }

  /** The verbatim-echo directive goes into `systemInstruction` (Gemini's system
   *  channel). Append a text part if present, create the Content if absent.
   *  Prefers whichever key the request already uses. */
  injectDirective(body: unknown): void {
    if (body === null || typeof body !== "object") return;
    const obj = body as { systemInstruction?: unknown; system_instruction?: unknown };
    const key = obj.system_instruction !== undefined && obj.systemInstruction === undefined
      ? "system_instruction" : "systemInstruction";
    const existing = obj[key];
    if (existing !== null && typeof existing === "object") {
      const c = existing as { parts?: unknown };
      if (Array.isArray(c.parts)) c.parts.push({ text: WYLOC_DIRECTIVE });
      else c.parts = [{ text: WYLOC_DIRECTIVE }];
    } else {
      (obj as Record<string, unknown>)[key] = { parts: [{ text: WYLOC_DIRECTIVE }] };
    }
  }

  rehydrateResponse(
    source: AsyncIterable<Uint8Array>,
    mappings: readonly MockMapping[],
  ): AsyncIterable<Uint8Array> {
    return rehydrateGeminiStream(source, mappings);
  }
}
