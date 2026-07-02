/**
 * Structural validation for wyloc.json — FAIL-CLOSED and specific.
 *
 * This checks SHAPE: required fields, types, enums, ranges, and unknown
 * (typo) keys. Pattern *compilation*, ReDoS, and self-tests live in compile.ts;
 * load.ts runs both and aggregates every error so the customer fixes the whole
 * file in one pass. Validators never throw — they collect messages.
 */

import {
  PATTERN_KEYS,
  POLY_LANGUAGES,
  WYLOC_TOP_LEVEL_KEYS,
  type CustomPattern,
  type Format,
  type WylocConfig,
} from "./schema.js";

const FORMAT_KINDS = ["digits", "alpha", "alnum", "hex", "upper", "lower", "upperalnum"];
const KNOWN_FORMATS = ["ipv4", "email", "uuid", "mac", "us_phone", "iban"];
const MATCH_TYPES = ["prefix", "context", "list", "known", "regex"];
const LOG_GRANULARITY = ["aggregate", "per_incident"];
const LOG_CATEGORIES = ["secrets", "pii", "custom", "code", "sql"];
const MAX_FORMAT_LEN = 4096;
const MAX_CONTEXT_WINDOW = 256;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Cheap edit-distance for "did you mean" hints. */
function closest(key: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return best && bestD <= 3 ? best : null;
}
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

function checkUnknownKeys(obj: Record<string, unknown>, known: readonly string[], where: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const hint = closest(key, known);
      errors.push(`${where}: unknown field ${JSON.stringify(key)}${hint ? ` (did you mean ${JSON.stringify(hint)}?)` : ""}`);
    }
  }
}

function validateFormat(v: unknown, where: string, errors: string[]): void {
  if (!isObject(v)) { errors.push(`${where}: must be an object like { "kind": "digits", "length": 6 }`); return; }
  if (typeof v.kind !== "string" || !FORMAT_KINDS.includes(v.kind))
    errors.push(`${where}.kind: must be one of ${FORMAT_KINDS.join(", ")}`);
  const hasLen = "length" in v;
  const hasRange = "min" in v || "max" in v;
  if (hasLen === hasRange)
    errors.push(`${where}: specify exactly one of "length" or "min"+"max"`);
  if (hasLen) {
    if (typeof v.length !== "number" || !Number.isInteger(v.length) || v.length < 1 || v.length > MAX_FORMAT_LEN)
      errors.push(`${where}.length: must be an integer between 1 and ${MAX_FORMAT_LEN}`);
  } else if (hasRange) {
    const min = v.min, max = v.max;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 1) errors.push(`${where}.min: must be an integer ≥ 1`);
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_FORMAT_LEN) errors.push(`${where}.max: must be an integer between 1 and ${MAX_FORMAT_LEN}`);
    if (typeof min === "number" && typeof max === "number" && min > max) errors.push(`${where}: "min" (${min}) must be ≤ "max" (${max})`);
  }
}

function validateMatch(v: unknown, where: string, errors: string[]): void {
  if (!isObject(v)) { errors.push(`${where}: must be an object with a "type"`); return; }
  const t = v.type;
  if (typeof t !== "string" || !MATCH_TYPES.includes(t)) {
    errors.push(`${where}.type: must be one of ${MATCH_TYPES.join(", ")}`);
    return;
  }
  switch (t) {
    case "prefix":
      if (typeof v.prefix !== "string" || v.prefix.length === 0) errors.push(`${where}.prefix: required non-empty string`);
      validateFormat(v.format, `${where}.format`, errors);
      break;
    case "context":
      if (!isStringArray(v.keywords) || v.keywords.length === 0) errors.push(`${where}.keywords: required non-empty string array`);
      validateFormat(v.value, `${where}.value`, errors);
      if ("window" in v && (typeof v.window !== "number" || !Number.isInteger(v.window) || v.window < 1 || v.window > MAX_CONTEXT_WINDOW))
        errors.push(`${where}.window: must be an integer between 1 and ${MAX_CONTEXT_WINDOW}`);
      break;
    case "list":
      if (!isStringArray(v.terms) || v.terms.length === 0) errors.push(`${where}.terms: required non-empty string array`);
      break;
    case "known":
      if (typeof v.format !== "string" || !KNOWN_FORMATS.includes(v.format)) errors.push(`${where}.format: must be one of ${KNOWN_FORMATS.join(", ")}`);
      break;
    case "regex":
      if (typeof v.source !== "string" || v.source.length === 0) errors.push(`${where}.source: required non-empty string`);
      if ("flags" in v && typeof v.flags !== "string") errors.push(`${where}.flags: must be a string`);
      // advanced + examples are enforced in compile.ts (strictest gate).
      break;
  }
}

function validatePattern(v: unknown, where: string, seenIds: Set<string>, errors: string[]): void {
  if (!isObject(v)) { errors.push(`${where}: must be an object`); return; }
  checkUnknownKeys(v, PATTERN_KEYS, where, errors);
  if (typeof v.name !== "string" || v.name.trim().length === 0) errors.push(`${where}.name: required non-empty string (non-sensitive label)`);
  if ("id" in v && (typeof v.id !== "string" || v.id.length === 0)) errors.push(`${where}.id: must be a non-empty string`);
  if ("action" in v && v.action !== "swap" && v.action !== "block") errors.push(`${where}.action: must be "swap" or "block"`);
  if ("examples" in v) {
    const ex = v.examples;
    if (!isObject(ex) || !isStringArray(ex.match)) errors.push(`${where}.examples: must be { "match": string[], "noMatch"?: string[] }`);
    else if ("noMatch" in ex && !isStringArray(ex.noMatch)) errors.push(`${where}.examples.noMatch: must be a string array`);
  }
  validateMatch(v.match, `${where}.match`, errors);

  const id = typeof v.id === "string" ? v.id : undefined;
  if (id) {
    if (seenIds.has(id)) errors.push(`${where}.id: duplicate id ${JSON.stringify(id)} (ids must be unique)`);
    seenIds.add(id);
  }
}

/** Validate the parsed JSON's structure. Returns the typed config + all errors. */
export function validateStructure(raw: unknown): { config: WylocConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { config: null, errors: ["wyloc.json: top-level value must be a JSON object"] };
  }
  checkUnknownKeys(raw, WYLOC_TOP_LEVEL_KEYS, "wyloc.json", errors);

  if (raw.version !== 1) errors.push(`wyloc.json.version: must be 1 (got ${JSON.stringify(raw.version)})`);

  if ("patterns" in raw) {
    if (!Array.isArray(raw.patterns)) errors.push(`wyloc.json.patterns: must be an array`);
    else {
      const seenIds = new Set<string>();
      raw.patterns.forEach((p, i) => validatePattern(p, `wyloc.json.patterns[${i}]`, seenIds, errors));
    }
  }

  for (const key of ["internalScopes", "internalDomains", "internalHosts", "internalTlds", "blocklist"] as const) {
    if (key in raw && !isStringArray(raw[key])) errors.push(`wyloc.json.${key}: must be an array of strings`);
  }

  if ("languages" in raw) {
    if (!isStringArray(raw.languages)) errors.push(`wyloc.json.languages: must be an array of strings`);
    else {
      for (const lang of raw.languages) {
        if (!(POLY_LANGUAGES as readonly string[]).includes(lang)) {
          const hint = closest(lang, POLY_LANGUAGES);
          errors.push(`wyloc.json.languages: unknown language ${JSON.stringify(lang)}${hint ? ` (did you mean ${JSON.stringify(hint)}?)` : ""} — supported: ${POLY_LANGUAGES.join(", ")} (TS/JS via policy.code)`);
        }
      }
    }
  }

  if ("internalPackagePrefixes" in raw) {
    const ipp = raw.internalPackagePrefixes;
    if (!isObject(ipp)) errors.push(`wyloc.json.internalPackagePrefixes: must be an object keyed by language`);
    else {
      checkUnknownKeys(ipp, POLY_LANGUAGES, "wyloc.json.internalPackagePrefixes", errors);
      for (const [lang, val] of Object.entries(ipp)) {
        if ((POLY_LANGUAGES as readonly string[]).includes(lang) && !isStringArray(val))
          errors.push(`wyloc.json.internalPackagePrefixes.${lang}: must be an array of strings`);
      }
    }
  }

  if ("policy" in raw) {
    const pol = raw.policy;
    if (!isObject(pol)) errors.push(`wyloc.json.policy: must be an object`);
    else {
      checkUnknownKeys(pol, ["sql", "code", "fileReads", "members", "pii"], "wyloc.json.policy", errors);
      for (const k of ["sql", "code", "fileReads", "members"] as const)
        if (k in pol && typeof pol[k] !== "boolean") errors.push(`wyloc.json.policy.${k}: must be a boolean`);
      if ("pii" in pol) {
        const pii = pol.pii;
        if (!isObject(pii)) errors.push(`wyloc.json.policy.pii: must be an object`);
        else {
          checkUnknownKeys(pii, ["creditCard", "ssn"], "wyloc.json.policy.pii", errors);
          for (const k of ["creditCard", "ssn"] as const)
            if (k in pii && typeof pii[k] !== "boolean") errors.push(`wyloc.json.policy.pii.${k}: must be a boolean`);
        }
      }
    }
  }

  if ("logging" in raw) {
    const log = raw.logging;
    if (!isObject(log)) errors.push(`wyloc.json.logging: must be an object`);
    else {
      checkUnknownKeys(log, ["default", "categories"], "wyloc.json.logging", errors);
      if ("default" in log && (typeof log.default !== "string" || !LOG_GRANULARITY.includes(log.default)))
        errors.push(`wyloc.json.logging.default: must be one of ${LOG_GRANULARITY.join(", ")}`);
      if ("categories" in log) {
        const cats = log.categories;
        if (!isObject(cats)) errors.push(`wyloc.json.logging.categories: must be an object`);
        else {
          checkUnknownKeys(cats, LOG_CATEGORIES, "wyloc.json.logging.categories", errors);
          for (const [k, val] of Object.entries(cats))
            if (typeof val !== "string" || !LOG_GRANULARITY.includes(val))
              errors.push(`wyloc.json.logging.categories.${k}: must be one of ${LOG_GRANULARITY.join(", ")}`);
        }
      }
    }
  }

  // Only hand back a typed config when structurally clean; compile.ts adds more.
  return { config: errors.length === 0 ? (raw as unknown as WylocConfig) : null, errors };
}

export type { CustomPattern };
