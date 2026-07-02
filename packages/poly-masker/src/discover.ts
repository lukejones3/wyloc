import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LanguageId } from "./types.js";

/**
 * Auto-discover per-language internal package prefixes from the project's own
 * manifests, so a repo with a go.mod (etc.) gets correct internal-vs-external
 * classification with ZERO wyloc.json configuration. Config always merges on
 * top; discovery only ever ADDS prefixes. Best-effort by design: a missing or
 * unreadable manifest contributes nothing (never throws).
 *
 * Sources per language:
 *   go:            go.mod `module` line
 *   java/kotlin:   pom.xml <groupId> / build.gradle(.kts) `group = "…"`
 *   csharp:        *.csproj <RootNamespace>, else the .csproj file name
 *   python:        pyproject.toml [project] name (normalized to module form)
 */
export function discoverInternalPrefixes(
  projectRoot: string,
): Partial<Record<LanguageId, string[]>> {
  const found: Partial<Record<LanguageId, string[]>> = {};
  if (!projectRoot) return found;

  const goModule = readGoModule(join(projectRoot, "go.mod"));
  if (goModule) found.go = [goModule];

  const jvmGroup = readJvmGroup(projectRoot);
  if (jvmGroup) {
    found.java = [`${jvmGroup}.`];
    found.kotlin = [`${jvmGroup}.`];
  }

  const rootNamespace = readCsprojRootNamespace(projectRoot);
  if (rootNamespace) found.csharp = [`${rootNamespace.split(".")[0]}.`];

  const pyPackage = readPyprojectName(join(projectRoot, "pyproject.toml"));
  if (pyPackage) found.python = [pyPackage];

  return found;
}

/** The `module <path>` line of a go.mod, if present and well-formed. */
function readGoModule(goModPath: string): string | null {
  const text = readTextIfExists(goModPath);
  return text?.match(/^\s*module\s+(\S+)\s*$/m)?.[1] ?? null;
}

/** pom.xml <groupId> or build.gradle(.kts) `group = "…"`. */
function readJvmGroup(root: string): string | null {
  const pom = readTextIfExists(join(root, "pom.xml"));
  const fromPom = pom?.match(/<groupId>\s*([\w.-]+)\s*<\/groupId>/)?.[1];
  if (fromPom) return fromPom;
  for (const file of ["build.gradle.kts", "build.gradle"]) {
    const gradle = readTextIfExists(join(root, file));
    const m = gradle?.match(/^\s*group\s*=?\s*["']([\w.-]+)["']/m)?.[1];
    if (m) return m;
  }
  return null;
}

/** First .csproj in the root: <RootNamespace>, else the project file name. */
function readCsprojRootNamespace(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const csproj = entries.find((e) => e.endsWith(".csproj"));
  if (!csproj) return null;
  const text = readTextIfExists(join(root, csproj));
  return (
    text?.match(/<RootNamespace>\s*([\w.]+)\s*<\/RootNamespace>/)?.[1] ??
    csproj.replace(/\.csproj$/, "")
  );
}

/** pyproject.toml [project]/[tool.poetry] name, normalized to module form. */
function readPyprojectName(path: string): string | null {
  const text = readTextIfExists(path);
  const name = text?.match(/^\s*name\s*=\s*["']([\w.-]+)["']/m)?.[1];
  return name ? name.replace(/-/g, "_") : null;
}

function readTextIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
