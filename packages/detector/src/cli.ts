#!/usr/bin/env node
/**
 * AI-DLP detector CLI.
 *
 * This is the ONE place Node APIs are allowed — the CLI is a thin shell
 * around the pure `scan()` core. The detector library itself stays free
 * of Node/DOM so it runs unchanged in the browser extension and IDE.
 *
 *   echo "AKIA..." | ai-dlp-scan
 *   ai-dlp-scan path/to/file.env
 *   ai-dlp-scan --json path/to/file
 *
 * Exit codes:  0 = clean,  1 = warn,  2 = block.
 */

import { readFileSync } from "node:fs";
import { scan, maskValue } from "./index.js";
import type { Action } from "./index.js";

const EXIT: Record<Action, number> = { allow: 0, warn: 1, block: 2 };

function readInput(args: string[]): string {
  const fileArg = args.find((a) => !a.startsWith("-"));
  if (fileArg) return readFileSync(fileArg, "utf8");
  // No file given — read stdin.
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const text = readInput(args);

  if (text.length === 0) {
    console.error("ai-dlp-scan: no input (pass a file path or pipe stdin)");
    process.exit(0);
  }

  const result = scan(text);

  if (asJson) {
    // Strip the raw value before printing — CLI JSON output is safe to
    // redirect into logs, so it must not carry secrets.
    const safe = {
      textLength: result.textLength,
      decision: result.decision,
      findings: result.findings.map((f) => ({
        type: f.type,
        layer: f.layer,
        confidence: f.confidence,
        environment: f.environment,
        ruleId: f.ruleId,
        start: f.start,
        end: f.end,
        masked: maskValue(f.value),
      })),
    };
    console.log(JSON.stringify(safe, null, 2));
    process.exit(EXIT[result.decision.action]);
  }

  console.log(`\n${result.decision.summary}`);
  if (result.findings.length > 0) {
    console.log("");
    result.findings.forEach((f, i) => {
      const action = result.decision.perFinding[i] ?? "warn";
      const tag = action === "block" ? "BLOCK" : "WARN ";
      console.log(
        `  [${tag}] ${f.type}  (${f.confidence}, ${f.environment})`,
      );
      console.log(`          ${f.reason}`);
      console.log(
        `          ${maskValue(f.value)}  at ${f.start}-${f.end}`,
      );
    });
  }
  console.log("");
  process.exit(EXIT[result.decision.action]);
}

main();
