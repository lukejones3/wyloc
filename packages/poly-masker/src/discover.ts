import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageId } from "./types.js";

/**
 * Auto-discover per-language internal package prefixes from the project's own
 * manifests, so a repo with a go.mod (etc.) gets correct internal-vs-external
 * classification with ZERO wyloc.json configuration. Config always merges on
 * top; discovery only ever ADDS prefixes. Best-effort by design: a missing or
 * unreadable manifest contributes nothing (never throws).
 *
 * Implemented per language as that language's masker lands:
 *   go:     go.mod `module` line                                   (done)
 *   java:   pom.xml groupId / build.gradle group                   (with Java)
 *   csharp: .csproj RootNamespace / project file name              (with C#)
 *   kotlin: same manifests as Java                                 (with Kotlin)
 *   python: pyproject.toml project name / top-level packages       (with Python)
 */
export function discoverInternalPrefixes(
  projectRoot: string,
): Partial<Record<LanguageId, string[]>> {
  const found: Partial<Record<LanguageId, string[]>> = {};
  if (!projectRoot) return found;

  const goModule = readGoModule(join(projectRoot, "go.mod"));
  if (goModule) found.go = [goModule];

  return found;
}

/** The `module <path>` line of a go.mod, if present and well-formed. */
function readGoModule(goModPath: string): string | null {
  try {
    if (!existsSync(goModPath)) return null;
    const text = readFileSync(goModPath, "utf8");
    const m = text.match(/^\s*module\s+(\S+)\s*$/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
