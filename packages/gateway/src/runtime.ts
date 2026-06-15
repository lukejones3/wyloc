/**
 * Bundled-runtime resolution for the standalone binary.
 *
 * The packaged product ships a self-contained runtime ALONGSIDE the executable
 * so SQL masking (Python + sqlglot) and raw-regex custom patterns (RE2) work
 * out-of-the-box with NO machine prerequisites:
 *
 *   <install>/
 *     wyloc                      ← the SEA binary (process.execPath)
 *     runtime/
 *       python/bin/python3       ← relocatable python-build-standalone + sqlglot
 *       sql/worker.py            ← the @wyloc/sql-masker sidecar
 *       re2/                     ← the prebuilt re2 package (node-LTS ABI)
 *
 * Everything is resolved RELATIVE TO THE BINARY (process.execPath), so the
 * install is fully relocatable. When a piece is absent (e.g. running from source
 * in dev, or a stripped install), the resolver returns null and the gateway
 * falls back to the system tool / its existing graceful degradation — it never
 * hard-fails for a missing bundled asset.
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** The directory the running executable lives in. */
function installDir(): string {
  return dirname(process.execPath);
}

/** `<install>/runtime`, the root of all bundled support files. */
export function runtimeDir(): string {
  return join(installDir(), "runtime");
}

/** Path to the bundled Python interpreter, or null if not shipped. */
export function bundledPython(): string | null {
  const p =
    process.platform === "win32"
      ? join(runtimeDir(), "python", "python.exe")
      : join(runtimeDir(), "python", "bin", "python3");
  return existsSync(p) ? p : null;
}

/** Path to the bundled sqlglot worker script, or null if not shipped. */
export function bundledSqlWorker(): string | null {
  const p = join(runtimeDir(), "sql", "worker.py");
  return existsSync(p) ? p : null;
}

/**
 * Path to the bundled RE2 package directory (requireable), or null. We ship the
 * whole installed package (index.js + build/Release/re2.node) so `require()` of
 * this path loads the native addon through its JS wrapper.
 */
export function bundledRe2Dir(): string | null {
  const p = join(runtimeDir(), "re2");
  return existsSync(join(p, "package.json")) ? p : null;
}

/** True when a bundled runtime directory is present next to the binary. */
export function hasBundledRuntime(): boolean {
  return existsSync(runtimeDir());
}
