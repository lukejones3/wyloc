/**
 * Load + validate + compile wyloc.json — the single fail-closed entry point.
 *
 * Behavior:
 *   • No file present  -> returns null (gateway runs on env/defaults, as before).
 *   • File present     -> parse, validate structure, compile every pattern,
 *                         self-test, ReDoS-check raw regex. If ANYTHING is
 *                         wrong, THROW `WylocConfigError` with every problem.
 *                         The gateway prints it and refuses to start.
 *
 * A security tool on a broken config gives false protection — worse than not
 * starting. So this never returns a partially-loaded config.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CompiledPattern } from "@wyloc/detector";
import { validateStructure } from "./validate.js";
import { compilePattern, compileListLike } from "./compile.js";
import type { LogGranularity, WylocConfig } from "./schema.js";

/** Rule ids for the built-in PII patterns, toggled via policy.pii. */
const PII_RULE_IDS = {
  creditCard: ["pii.credit_card"],
  ssn: ["pii.ssn_dashed", "pii.ssn_context"],
} as const;

/** Thrown when the config is invalid. `problems` is every issue found. */
export class WylocConfigError extends Error {
  constructor(readonly path: string, readonly problems: string[]) {
    super(`Invalid wyloc.json (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    this.name = "WylocConfigError";
  }
  /** A clear, specific, multi-line report for the operator. */
  format(): string {
    return [
      `✗ wyloc.json is invalid — the gateway will not start.`,
      `  file: ${this.path}`,
      ``,
      ...this.problems.map((p) => `  • ${p}`),
      ``,
      `  Fix the above and restart. (A security gateway never runs on a broken config.)`,
    ].join("\n");
  }
}

/** The compiled, ready-to-wire result handed to the gateway. */
export interface LoadedWylocConfig {
  path: string;
  raw: WylocConfig;
  /** Custom + blocklist + internal-host patterns, for DetectorConfig.customPatterns. */
  customPatterns: CompiledPattern[];
  /** Code-masker internalScopes allowlist. */
  internalScopes: string[];
  /** Code-masker internalDomains (org domains + specific hosts). */
  internalDomains: string[];
  /** Code-masker internalTlds (extends defaults). */
  internalTlds: string[];
  /** Substrings for the sql/code masker literal passes (blocklist). */
  blocklistSubstrings: string[];
  /** Poly-masker languages (undefined = key absent, keep env behavior). */
  languages: string[] | undefined;
  /** Poly-masker per-language internal prefixes. */
  internalPackagePrefixes: Partial<Record<string, string[]>>;
  /** Policy toggles actually present in the file (undefined = not set). */
  policy: {
    sql?: boolean; code?: boolean; fileReads?: boolean; members?: boolean;
    creditCard?: boolean; ssn?: boolean;
  };
  /** Detector ruleIds to suppress because a PII category was turned off. */
  suppressedRuleIds: string[];
  /** Logging granularity (schema validated; consumption partial for now). */
  logging: { default: LogGranularity; categories: Record<string, LogGranularity> };
}

/** Resolve the config path: explicit WYLOC_CONFIG, else ./wyloc.json in cwd. */
export function wylocConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WYLOC_CONFIG && env.WYLOC_CONFIG.length > 0
    ? resolve(env.WYLOC_CONFIG)
    : resolve(process.cwd(), "wyloc.json");
}

/**
 * Load and compile the config. Returns null if no file exists. Throws
 * `WylocConfigError` (fail-closed) on any structural, compile, ReDoS, or
 * self-test problem — aggregating ALL problems so they can be fixed at once.
 */
export function loadWylocConfig(path: string = wylocConfigPath()): LoadedWylocConfig | null {
  if (!existsSync(path)) return null;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new WylocConfigError(path, [`could not read file: ${(e as Error).message}`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WylocConfigError(path, [`not valid JSON: ${(e as Error).message}`]);
  }

  const { config, errors } = validateStructure(parsed);
  const problems = [...errors];

  // Compile patterns only if structure is sound (so types are trustworthy).
  const customPatterns: CompiledPattern[] = [];
  if (config) {
    (config.patterns ?? []).forEach((p, i) => {
      const { compiled, errors: cErrors } = compilePattern(p, `wyloc.json.patterns[${i}] (${p.name ?? "?"})`);
      problems.push(...cErrors);
      if (compiled) customPatterns.push(compiled);
    });
  }

  if (problems.length > 0 || !config) {
    throw new WylocConfigError(path, problems.length > 0 ? problems : ["unknown validation failure"]);
  }

  // Internal hosts + domains: mask everywhere via a detector list pattern AND
  // feed the code-masker's internalDomains for in-code host-shape masking.
  const internalDomains = [...(config.internalDomains ?? []), ...(config.internalHosts ?? [])];
  const hostPattern = compileListLike("wyloc.internal_host", "internal host", internalDomains, { caseInsensitive: true });
  if (hostPattern) customPatterns.push(hostPattern);

  // Blocklist: mask everywhere via a detector list pattern AND feed the
  // sql/code masker literal passes as substrings.
  const blocklist = config.blocklist ?? [];
  const blockPattern = compileListLike("wyloc.blocklist", "blocklisted term", blocklist, { wholeWord: true, caseInsensitive: true });
  if (blockPattern) customPatterns.push(blockPattern);

  // Normalize scope globs to the prefix form the code-masker matches via
  // startsWith: "@acme/*" -> "@acme/" (matches @acme/anything), "@acme*" -> "@acme".
  const internalScopes = (config.internalScopes ?? []).map((s) =>
    s.endsWith("/*") ? s.slice(0, -1) : s.endsWith("*") ? s.slice(0, -1) : s,
  );

  const suppressedRuleIds: string[] = [];
  if (config.policy?.pii?.creditCard === false) suppressedRuleIds.push(...PII_RULE_IDS.creditCard);
  if (config.policy?.pii?.ssn === false) suppressedRuleIds.push(...PII_RULE_IDS.ssn);

  return {
    path,
    raw: config,
    customPatterns,
    internalScopes,
    internalDomains,
    internalTlds: config.internalTlds ?? [],
    blocklistSubstrings: blocklist,
    languages: config.languages,
    internalPackagePrefixes: config.internalPackagePrefixes ?? {},
    policy: {
      ...(config.policy?.sql !== undefined ? { sql: config.policy.sql } : {}),
      ...(config.policy?.code !== undefined ? { code: config.policy.code } : {}),
      ...(config.policy?.fileReads !== undefined ? { fileReads: config.policy.fileReads } : {}),
      ...(config.policy?.members !== undefined ? { members: config.policy.members } : {}),
      ...(config.policy?.pii?.creditCard !== undefined ? { creditCard: config.policy.pii.creditCard } : {}),
      ...(config.policy?.pii?.ssn !== undefined ? { ssn: config.policy.pii.ssn } : {}),
    },
    suppressedRuleIds,
    logging: {
      default: config.logging?.default ?? "aggregate",
      categories: config.logging?.categories ?? {},
    },
  };
}
