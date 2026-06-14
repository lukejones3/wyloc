/**
 * Compile wyloc.json patterns into the detector's runtime `CompiledPattern`
 * shape — reuse, not a parallel engine. Constrained types compile to
 * safe-by-construction bounded regex on the native engine; the `regex` escape
 * hatch compiles on RE2 (linear time) and is FAIL-CLOSED when RE2 is absent.
 */

import { createRequire } from "node:module";
import type { CompiledPattern } from "@wyloc/detector";
import type { CustomPattern, Format, FormatKind, KnownFormat, Match } from "./schema.js";
import { findReDoSRisk } from "./redos.js";

const require = createRequire(import.meta.url);

/** Lazy, cached RE2 load. Returns the constructor or null if unavailable. */
let re2Cache: { ctor: unknown } | undefined;
export function loadRe2(): unknown | null {
  if (re2Cache === undefined) {
    try {
      re2Cache = { ctor: require("re2") };
    } catch {
      re2Cache = { ctor: null };
    }
  }
  return re2Cache.ctor;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Identifier-safe boundary so EMP-123456 isn't matched inside EMP-1234567. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

function classFor(kind: FormatKind): string {
  switch (kind) {
    case "digits": return "\\d";
    case "alpha": return "[A-Za-z]";
    case "alnum": return "[A-Za-z0-9]";
    case "hex": return "[0-9A-Fa-f]";
    case "upper": return "[A-Z]";
    case "lower": return "[a-z]";
    case "upperalnum": return "[A-Z0-9]";
  }
}

function quantFor(fmt: Format): string {
  return "length" in fmt ? `{${fmt.length}}` : `{${fmt.min},${fmt.max}}`;
}

/** A bounded run of one character class — never nested, can't ReDoS. */
export function formatToRegex(fmt: Format): string {
  return `${classFor(fmt.kind)}${quantFor(fmt)}`;
}

const KNOWN_FORMATS: Record<KnownFormat, { source: string; flags: string }> = {
  ipv4: { source: `${LB}(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)${RB}`, flags: "" },
  email: { source: `${LB}[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,24}${RB}`, flags: "i" },
  uuid: { source: `(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])`, flags: "" },
  mac: { source: `(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])`, flags: "" },
  us_phone: { source: `(?<!\\d)(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}(?!\\d)`, flags: "" },
  iban: { source: `(?<![A-Z0-9])[A-Z]{2}\\d{2}[A-Z0-9]{10,30}(?![A-Z0-9])`, flags: "" },
};

export function slugId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "custom";
}

/** Result of compiling: a CompiledPattern, plus the {source,flags,captureGroup} used. */
interface BuiltRegex {
  source: string;
  flags: string;
  captureGroup?: number;
}

/** Build the regex spec for a match (no compilation yet). Returns null on bad shape. */
function buildRegex(m: Match): { built?: BuiltRegex; error?: string } {
  switch (m.type) {
    case "prefix": {
      const flags = m.caseInsensitive ? "i" : "";
      return { built: { source: `${LB}${escapeRegex(m.prefix)}${formatToRegex(m.format)}${RB}`, flags } };
    }
    case "context": {
      const window = m.window ?? 16;
      const kw = m.keywords.map(escapeRegex).join("|");
      // value within `window` non-newline chars of a keyword; value is group 1.
      return { built: { source: `(?:${kw})[^\\n]{0,${window}}(${formatToRegex(m.value)})`, flags: "i", captureGroup: 1 } };
    }
    case "list": {
      const alt = m.terms.map(escapeRegex).join("|");
      const flags = m.caseInsensitive ? "i" : "";
      const src = m.wholeWord ? `${LB}(?:${alt})${RB}` : `(?:${alt})`;
      return { built: { source: src, flags } };
    }
    case "known": {
      const kf = KNOWN_FORMATS[m.format];
      return { built: { source: kf.source, flags: kf.flags } };
    }
    case "regex": {
      return { built: { source: m.source, flags: m.flags ?? "" } };
    }
  }
}

/** A regex-like object the detector scanner can drive (native RegExp or RE2). */
type ScannerRegex = RegExp;

/** Compile a source+flags into a global regex; raw patterns go through RE2. */
function compileRegex(
  built: BuiltRegex,
  raw: boolean,
): { regex?: ScannerRegex; error?: string } {
  const flags = built.flags.includes("g") ? built.flags : built.flags + "g";
  if (raw) {
    const RE2 = loadRe2() as (new (src: string, flags: string) => unknown) | null;
    if (!RE2) {
      return { error: "raw `type:\"regex\"` requires the RE2 engine, which is not available in this environment. Install `re2`, or use a constrained pattern type (prefix/context/list/known)." };
    }
    try {
      return { regex: new RE2(built.source, flags) as unknown as ScannerRegex };
    } catch (e) {
      return { error: `RE2 rejected the pattern: ${(e as Error).message}` };
    }
  }
  try {
    return { regex: new RegExp(built.source, flags) };
  } catch (e) {
    return { error: `regex did not compile: ${(e as Error).message}` };
  }
}

/** Does `regex` fire on `s`? Stateless (resets lastIndex). */
function fires(regex: ScannerRegex, s: string): boolean {
  regex.lastIndex = 0;
  return regex.test(s);
}

/**
 * Compile one CustomPattern. Returns the CompiledPattern or a list of errors
 * (field problems, ReDoS, RE2-unavailable, failed self-tests) — never throws.
 */
export function compilePattern(
  p: CustomPattern,
  where: string,
): { compiled?: CompiledPattern; errors: string[] } {
  const errors: string[] = [];
  const m = p.match;
  const raw = m.type === "regex";

  if (raw) {
    if (m.advanced !== true) errors.push(`${where}: raw \`type:"regex"\` must set \`"advanced": true\` to acknowledge it bypasses the safe constrained types`);
    if (!p.examples || p.examples.match.length === 0) errors.push(`${where}: raw \`type:"regex"\` requires at least one \`examples.match\` to prove it works`);
    const risk = findReDoSRisk(m.source);
    if (risk) errors.push(`${where}: ${risk}. Rewrite without nested quantifiers, or use a constrained pattern type.`);
  }

  const { built, error: shapeErr } = buildRegex(m);
  if (shapeErr) errors.push(`${where}: ${shapeErr}`);
  if (!built || errors.length > 0) return { errors };

  const { regex, error: compileErr } = compileRegex(built, raw);
  if (compileErr || !regex) {
    errors.push(`${where}: ${compileErr}`);
    return { errors };
  }

  // Self-test against examples.
  if (p.examples) {
    for (const ex of p.examples.match) {
      if (!fires(regex, ex)) errors.push(`${where}: example expected to match did not: ${JSON.stringify(ex)}`);
    }
    for (const ex of p.examples.noMatch ?? []) {
      if (fires(regex, ex)) errors.push(`${where}: example expected NOT to match did: ${JSON.stringify(ex)}`);
    }
  }
  if (errors.length > 0) return { errors };

  const compiled: CompiledPattern = {
    id: p.id ?? `wyloc.${slugId(p.name)}`,
    displayName: p.name,
    type: "custom",
    tier: m.type === "context" || raw ? "tier_2" : "tier_1",
    confidence: "high",
    blockEligible: p.action === "block",
    reason: `Custom org pattern: ${p.name}`,
    regex,
    maskHint: p.name,
    ...(built.captureGroup !== undefined ? { captureGroup: built.captureGroup } : {}),
  };
  return { compiled, errors };
}

/** Build a single tier_1 list pattern (blocklist terms, internal hosts/domains). */
export function compileListLike(
  id: string,
  label: string,
  terms: readonly string[],
  opts: { wholeWord?: boolean; caseInsensitive?: boolean } = {},
): CompiledPattern | null {
  const clean = terms.filter((t) => t.length > 0);
  if (clean.length === 0) return null;
  const alt = clean.map(escapeRegex).join("|");
  const src = opts.wholeWord ? `${LB}(?:${alt})${RB}` : `(?:${alt})`;
  const flags = (opts.caseInsensitive ? "i" : "") + "g";
  return {
    id,
    displayName: label,
    type: "custom",
    tier: "tier_1",
    confidence: "high",
    blockEligible: false,
    reason: `Custom org rule: ${label}`,
    regex: new RegExp(src, flags),
    maskHint: label,
  };
}
