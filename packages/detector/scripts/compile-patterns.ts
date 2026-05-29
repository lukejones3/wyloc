/**
 * Build-time pattern compiler.
 *
 * Reads every JSON definition in src/patterns/definitions/, validates it, and
 * emits src/patterns/compiled.generated.ts — a pure TypeScript module holding
 * the in-memory pattern table the scanner consumes. The browser runtime never
 * parses the JSON; it imports the generated table.
 *
 * A malformed or unsafe definition FAILS THE BUILD here (non-zero exit), so a
 * bad pattern can never silently break detection at runtime.
 *
 * This is a build tool: it uses Node APIs and is NOT part of the shipped
 * detector. Run via `npm run compile:patterns` (and as a `build` prestep).
 *
 *   tsx scripts/compile-patterns.ts            # compile
 *   tsx scripts/compile-patterns.ts --check    # fail if output is stale
 *   tsx scripts/compile-patterns.ts --dir <d>  # compile definitions from <d>
 *   tsx scripts/compile-patterns.ts --out <f>  # write the table to <f>
 *
 * The --dir/--out overrides exist so the test suite can drive the compiler
 * against known-bad fixture definitions and assert it fails the build.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validators } from "../src/patterns/validators.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEFINITIONS_DIR = join(here, "..", "src", "patterns", "definitions");
const DEFAULT_OUTPUT_FILE = join(here, "..", "src", "patterns", "compiled.generated.ts");

/** Read the value following a flag, e.g. `--dir foo` -> "foo". */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CONFIDENCE = new Set(["low", "medium", "high"]);
const TIERS = new Set(["tier_1", "tier_2", "tier_3"]);

/** A validation failure tied to the file it came from. */
class DefinitionError extends Error {}

function fail(file: string, msg: string): never {
  throw new DefinitionError(`${file}: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Compile a regex source + flags, ensuring the global flag is present. */
function compileRegex(
  file: string,
  field: string,
  spec: unknown,
  forceGlobal: boolean,
): { source: string; flags: string } {
  if (!isPlainObject(spec) || typeof spec.source !== "string") {
    fail(file, `${field} must be { source: string, flags?: string }`);
  }
  const source = spec.source as string;
  let flags = "";
  if (spec.flags !== undefined) {
    if (typeof spec.flags !== "string") fail(file, `${field}.flags must be a string`);
    flags = spec.flags;
  }
  if (forceGlobal && !flags.includes("g")) flags += "g";
  try {
    new RegExp(source, flags);
  } catch (e) {
    fail(file, `${field} is not a valid regex: ${(e as Error).message}`);
  }
  return { source, flags };
}

/** A fully validated, ready-to-emit pattern. */
interface Normalised {
  id: string;
  displayName: string;
  type: string;
  tier: string;
  confidence: string;
  blockEligible: boolean;
  reason: string;
  regex: { source: string; flags: string };
  captureGroup?: number;
  structuralValidator?: string;
  requiredContext?: string[];
  contextRegex?: { source: string; flags: string };
  entropyThreshold?: number;
}

function validate(file: string, raw: unknown): Normalised {
  if (!isPlainObject(raw)) fail(file, "definition must be a JSON object");
  const d = raw;

  const str = (field: string): string => {
    const v = d[field];
    if (typeof v !== "string" || v.length === 0) {
      fail(file, `${field} must be a non-empty string`);
    }
    return v;
  };

  const id = str("id");
  const displayName = str("displayName");
  const type = str("type");
  const reason = str("reason");

  const tier = d.tier;
  if (typeof tier !== "string" || !TIERS.has(tier)) {
    fail(file, `tier must be one of ${[...TIERS].join(", ")}`);
  }

  const confidence = d.confidence;
  if (typeof confidence !== "string" || !CONFIDENCE.has(confidence)) {
    fail(file, `confidence must be one of ${[...CONFIDENCE].join(", ")}`);
  }

  if (typeof d.blockEligible !== "boolean") {
    fail(file, "blockEligible must be a boolean");
  }

  const regex = compileRegex(file, "regex", d.regex, true);

  const out: Normalised = {
    id,
    displayName,
    type,
    tier,
    confidence,
    blockEligible: d.blockEligible,
    reason,
    regex,
  };

  if (d.captureGroup !== undefined) {
    if (
      typeof d.captureGroup !== "number" ||
      !Number.isInteger(d.captureGroup) ||
      d.captureGroup < 0
    ) {
      fail(file, "captureGroup must be a non-negative integer");
    }
    out.captureGroup = d.captureGroup;
  }

  // ── Fixtures travel with every definition ────────────────────────────
  const fixtures = d.fixtures;
  if (!isPlainObject(fixtures)) fail(file, "fixtures is required");
  if (!isStringArray(fixtures.positive) || fixtures.positive.length === 0) {
    fail(file, "fixtures.positive must be a non-empty array of strings");
  }
  if (fixtures.negative !== undefined && !isStringArray(fixtures.negative)) {
    fail(file, "fixtures.negative must be an array of strings");
  }

  // ── Tier-specific rules ──────────────────────────────────────────────
  if (tier === "tier_2") {
    if (d.structuralValidator !== undefined) {
      if (typeof d.structuralValidator !== "string") {
        fail(file, "structuralValidator must be a string");
      }
      if (!(d.structuralValidator in validators)) {
        fail(
          file,
          `structuralValidator "${d.structuralValidator}" is not registered in validators.ts`,
        );
      }
      out.structuralValidator = d.structuralValidator;
    }
  }

  if (tier === "tier_3") {
    // The core safety constraint: a generic high-entropy pattern is only
    // safe if it is gated on required context and an entropy floor.
    if (!isStringArray(d.requiredContext) || d.requiredContext.length === 0) {
      fail(
        file,
        "tier_3 patterns MUST declare a non-empty requiredContext array",
      );
    }
    if (typeof d.entropyThreshold !== "number" || !(d.entropyThreshold > 0)) {
      fail(file, "tier_3 patterns MUST declare a positive entropyThreshold");
    }
    out.requiredContext = d.requiredContext.map((k) => k.toLowerCase());
    out.entropyThreshold = d.entropyThreshold;
    if (d.contextRegex !== undefined) {
      out.contextRegex = compileRegex(file, "contextRegex", d.contextRegex, false);
    }
  } else {
    // Guard against tier_3-only fields appearing on the wrong tier.
    for (const f of ["requiredContext", "contextRegex", "entropyThreshold"]) {
      if (d[f] !== undefined) {
        fail(file, `${f} is only valid on tier_3 patterns`);
      }
    }
  }

  return out;
}

// ── Code generation ────────────────────────────────────────────────────

function regexLiteral(r: { source: string; flags: string }): string {
  // Emit `new RegExp(<json source>, "<flags>")` — safe escaping via JSON,
  // equivalent to a literal at runtime, constructed once at module load.
  return `new RegExp(${JSON.stringify(r.source)}, ${JSON.stringify(r.flags)})`;
}

function emitPattern(p: Normalised): string {
  const lines: string[] = [];
  lines.push("  {");
  lines.push(`    id: ${JSON.stringify(p.id)},`);
  lines.push(`    displayName: ${JSON.stringify(p.displayName)},`);
  lines.push(`    type: ${JSON.stringify(p.type)},`);
  lines.push(`    tier: ${JSON.stringify(p.tier)},`);
  lines.push(`    confidence: ${JSON.stringify(p.confidence)},`);
  lines.push(`    blockEligible: ${p.blockEligible},`);
  lines.push(`    reason: ${JSON.stringify(p.reason)},`);
  lines.push(`    regex: ${regexLiteral(p.regex)},`);
  // Optional keys are OMITTED when absent (exactOptionalPropertyTypes).
  if (p.captureGroup !== undefined) {
    lines.push(`    captureGroup: ${p.captureGroup},`);
  }
  if (p.structuralValidator !== undefined) {
    lines.push(`    structuralValidator: validators[${JSON.stringify(p.structuralValidator)}],`);
  }
  if (p.requiredContext !== undefined) {
    lines.push(`    requiredContext: ${JSON.stringify(p.requiredContext)},`);
  }
  if (p.contextRegex !== undefined) {
    lines.push(`    contextRegex: ${regexLiteral(p.contextRegex)},`);
  }
  if (p.entropyThreshold !== undefined) {
    lines.push(`    entropyThreshold: ${p.entropyThreshold},`);
  }
  lines.push("  },");
  return lines.join("\n");
}

function generate(patterns: Normalised[]): string {
  const usesValidators = patterns.some((p) => p.structuralValidator !== undefined);
  const header = `/**
 * AUTO-GENERATED by scripts/compile-patterns.ts — DO NOT EDIT BY HAND.
 *
 * Source of truth: src/patterns/definitions/*.json
 * Regenerate with: npm run compile:patterns
 *
 * This is the pre-compiled pattern table the scanner consumes at runtime.
 * The browser/IDE/CLI runtime never parses the JSON definitions.
 */

import type { CompiledPattern } from "./schema.js";`;
  const validatorImport = usesValidators
    ? '\nimport { validators } from "./validators.js";'
    : "";
  const body = patterns.map(emitPattern).join("\n");
  return `${header}${validatorImport}

export const COMPILED_PATTERNS: readonly CompiledPattern[] = [
${body}
];
`;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const dirArg = argValue("--dir");
  const outArg = argValue("--out");
  const definitionsDir = dirArg ? resolve(dirArg) : DEFAULT_DEFINITIONS_DIR;
  const outputFile = outArg ? resolve(outArg) : DEFAULT_OUTPUT_FILE;

  const files = readdirSync(definitionsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`No pattern definitions found in ${definitionsDir}`);
    process.exit(1);
  }

  const patterns: Normalised[] = [];
  const seenIds = new Set<string>();
  try {
    for (const file of files) {
      const text = readFileSync(join(definitionsDir, file), "utf8");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        fail(file, `invalid JSON: ${(e as Error).message}`);
      }
      const p = validate(file, raw);
      if (seenIds.has(p.id)) fail(file, `duplicate pattern id "${p.id}"`);
      seenIds.add(p.id);
      patterns.push(p);
    }
  } catch (e) {
    if (e instanceof DefinitionError) {
      console.error(`\n✗ Pattern compilation failed\n  ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  // Deterministic order by id so output is stable across machines.
  patterns.sort((a, b) => a.id.localeCompare(b.id));

  const output = generate(patterns);

  if (checkOnly) {
    let current = "";
    try {
      current = readFileSync(outputFile, "utf8");
    } catch {
      /* missing — treat as stale */
    }
    if (current !== output) {
      console.error(
        "\n✗ compiled.generated.ts is stale. Run `npm run compile:patterns`.\n",
      );
      process.exit(1);
    }
    console.log(`✓ compiled.generated.ts up to date (${patterns.length} patterns).`);
    return;
  }

  writeFileSync(outputFile, output);
  console.log(`✓ Compiled ${patterns.length} pattern(s) -> compiled.generated.ts`);
}

main();
