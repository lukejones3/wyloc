#!/usr/bin/env node
/**
 * Build the standalone Wyloc gateway distribution for one platform.
 *
 *   node scripts/build-binary.mjs [--platform <key>] [--out <dir>] [--no-runtime]
 *
 * Produces:  <out>/<platform>/
 *   wyloc[.exe]                 ← Node SEA binary (pinned Node 22 LTS)
 *   runtime/python/…            ← relocatable python + sqlglot (SQL masking)
 *   runtime/sql/worker.py       ← the sqlglot sidecar
 *   runtime/re2/                ← prebuilt RE2 package (raw-regex safety)
 *
 * WHY THESE PINS (from the Phase-1 spike):
 *  • Node 22 LTS, not the dev's Node — official monolithic binaries inject
 *    cleanly, and re2 ships a prebuilt for the LTS ABI (newer ABIs may not yet).
 *  • esbuild bundles ESM→CJS with an import.meta.url shim so createRequire works.
 *  • The bundled runtime is resolved RELATIVE TO THE BINARY at runtime
 *    (src/runtime.ts), so SQL + raw-regex work with no machine prerequisites;
 *    if a piece is missing the gateway degrades rather than failing.
 *
 * CROSS-PLATFORM: pure Node + `tar` (universal) + a JS fuse scan, so the SAME
 * script runs natively on macOS / Linux / Windows runners. Build each target on
 * its own native OS (target == host); cross-building is intentionally not done
 * here because the clean-machine verification must run on real hardware.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as esbuild from "esbuild";

const GATEWAY = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO = resolve(GATEWAY, "..", "..");

// ── Pins ──────────────────────────────────────────────────────────────────────
const NODE_VERSION = "22.14.0";
const RE2_VERSION = "1.21.4";
const PY_TAG = "20250115";
const PY_CPYTHON = "cpython-3.12.8+20250115";

/** Per-platform artifact coordinates. */
const PLATFORMS = {
  "darwin-arm64": { node: "darwin-arm64", ext: "tar.gz", py: "aarch64-apple-darwin", exe: "", sign: "codesign" },
  "darwin-x64": { node: "darwin-x64", ext: "tar.gz", py: "x86_64-apple-darwin", exe: "", sign: "codesign" },
  "linux-x64": { node: "linux-x64", ext: "tar.gz", py: "x86_64-unknown-linux-gnu", exe: "", sign: null },
  "linux-arm64": { node: "linux-arm64", ext: "tar.gz", py: "aarch64-unknown-linux-gnu", exe: "", sign: null },
  "win-x64": { node: "win-x64", ext: "zip", py: "x86_64-pc-windows-msvc", exe: ".exe", sign: "signtool" },
};

function hostPlatform() {
  const a = process.arch === "arm64" ? "arm64" : "x64";
  const o = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux";
  return `${o}-${a}`;
}

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const platform = valueOf("--platform") ?? hostPlatform();
const outRoot = resolve(valueOf("--out") ?? join(GATEWAY, "dist-bin"));
const withRuntime = !args.includes("--no-runtime");
function valueOf(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

const spec = PLATFORMS[platform];
if (!spec) fail(`unknown platform ${platform}; one of: ${Object.keys(PLATFORMS).join(", ")}`);
const isWin = platform.startsWith("win");

const CACHE = join(homedir(), ".cache", "wyloc-build");
mkdirSync(CACHE, { recursive: true });
const out = join(outRoot, platform);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "runtime"), { recursive: true });

// ── cross-platform helpers ─────────────────────────────────────────────────────
function run(file, argv, opts = {}) { execFileSync(file, argv, { stdio: "inherit", ...opts }); }
/** npm/npx need a shell on Windows (.cmd); use a single string + shell:true. */
function shell(cmd, opts = {}) { execFileSync(cmd, [], { stdio: "inherit", shell: true, ...opts }); }
function fail(msg) { console.error(`\n✗ build-binary: ${msg}\n`); process.exit(1); }
function step(msg) { console.error(`\n▸ ${msg}`); }
async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`download failed (${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
/** `tar` ships on macOS, Linux, and Windows 10+ (bsdtar handles .zip too). */
function extract(archive, dir) { run("tar", ["-xf", archive, "-C", dir]); }
/** Read the SEA fuse sentinel straight from the Node binary (no `strings`). */
function readFuse(binPath) {
  const m = readFileSync(binPath).toString("latin1").match(/NODE_SEA_FUSE_[0-9a-f]{16,}/);
  return m ? m[0] : null;
}
function firstExisting(...paths) { return paths.find((p) => existsSync(p)) ?? null; }

await main();

async function main() {
  // ── 1. Pinned Node 22 LTS (official monolithic) ──────────────────────────────
  step(`Node ${NODE_VERSION} (${spec.node})`);
  const nodeDir = join(CACHE, `node-v${NODE_VERSION}-${spec.node}`);
  const nodeBin = isWin ? join(nodeDir, "node.exe") : join(nodeDir, "bin", "node");
  if (!existsSync(nodeBin)) {
    const archive = join(CACHE, `node-v${NODE_VERSION}-${spec.node}.${spec.ext}`);
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${spec.node}.${spec.ext}`, archive);
    extract(archive, CACHE);
  }
  if (!existsSync(nodeBin)) fail(`Node binary not found at ${nodeBin}`);

  // ── 2. Build workspaces + esbuild bundle (ESM→CJS, import.meta shim) ─────────
  // build:gateway = the binary's dependency chain ONLY (detector → sql-masker/
  // code-masker → gateway). Deliberately NOT the full `build`: the binary does
  // not include @wyloc/browser-extension, whose own esbuild bundling is
  // unrelated (and has a Windows path-alias quirk we must not drag in here).
  step("build workspace packages (gateway chain)");
  shell(`npm run build:gateway --silent`, { cwd: REPO });
  const bundle = join(CACHE, "gateway.cjs");
  // esbuild JS API (cross-platform; the bin is a native binary, not a node script).
  await esbuild.build({
    entryPoints: [join(GATEWAY, "dist", "index.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["re2"],
    // import.meta.url is empty in CJS → createRequire(undefined) throws. Shim it
    // to the binary's own path so re2/worker.py resolve relative to the binary.
    banner: { js: `const _importMetaUrl=require("url").pathToFileURL(__filename).href;` },
    define: { "import.meta.url": "_importMetaUrl" },
    outfile: bundle,
  });
  // Strip the shebang — invalid as the first line of a SEA blob (parsed as JS).
  const stripped = join(CACHE, "gateway.sea.cjs");
  writeFileSync(stripped, readFileSync(bundle, "utf8").replace(/^#![^\n]*\n/, ""));

  // ── 3. SEA blob (generated by the SAME pinned Node) ──────────────────────────
  step("SEA blob");
  const seaCfg = join(CACHE, "sea-config.json");
  const blob = join(CACHE, "gateway.blob");
  writeFileSync(seaCfg, JSON.stringify({ main: stripped, output: blob }));
  run(nodeBin, ["--experimental-sea-config", seaCfg]);

  // ── 4. Inject the blob into a copy of the Node binary ────────────────────────
  step("assemble binary");
  const exe = join(out, `wyloc${spec.exe}`);
  cpSync(nodeBin, exe);
  if (!isWin) chmodSync(exe, 0o755);
  const fuse = readFuse(nodeBin);
  if (!fuse) fail("could not read the SEA fuse sentinel from the Node binary");

  // Strip the upstream signature before injecting (macOS); re-sign after.
  if (spec.sign === "codesign") tryRun("codesign", ["--remove-signature", exe]);

  const postjectCli = firstExisting(
    join(REPO, "node_modules", "postject", "dist", "cli.js"),
    join(GATEWAY, "node_modules", "postject", "dist", "cli.js"),
  );
  if (!postjectCli) fail("postject not installed — add it to the gateway devDependencies");
  run(process.execPath, [
    postjectCli, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", fuse,
    ...(spec.node.startsWith("darwin") ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);

  // ── Signing ──────────────────────────────────────────────────────────────────
  // CI uses AD-HOC / unsigned so the binary runs for testing. Real distribution
  // signing plugs in HERE later (fill in the secret; no rebuild needed):
  //
  //   macOS (Developer ID):
  //     codesign --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "${exe}"
  //     # then notarize: xcrun notarytool submit … --apple-id "$APPLE_ID" \
  //     #   --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
  //   Windows (Authenticode):
  //     signtool sign /fd SHA256 /f "$WINDOWS_CERT_PFX" /p "$WINDOWS_CERT_PASSWORD" \
  //       /tr http://timestamp.digicert.com /td SHA256 "${exe}"
  //
  if (spec.sign === "codesign") tryRun("codesign", ["--sign", "-", exe]); // ad-hoc
  // (Windows ad-hoc: left unsigned in CI — runs fine for local/SmartScreen-warned testing.)

  if (!withRuntime) { console.error(`\n✓ binary only: ${exe}\n`); return; }

  // ── 5. Bundled runtime: worker.py ────────────────────────────────────────────
  step("runtime/sql/worker.py");
  mkdirSync(join(out, "runtime", "sql"), { recursive: true });
  cpSync(join(REPO, "packages", "sql-masker", "python", "worker.py"), join(out, "runtime", "sql", "worker.py"));

  // ── 6. Bundled runtime: RE2 prebuilt (installed with the PINNED Node) ─────────
  step(`runtime/re2 (re2 ${RE2_VERSION} prebuilt for Node ${NODE_VERSION} ABI)`);
  const re2tmp = join(CACHE, "re2-install");
  rmSync(re2tmp, { recursive: true, force: true }); mkdirSync(re2tmp, { recursive: true });
  writeFileSync(join(re2tmp, "package.json"), JSON.stringify({ name: "r", version: "1.0.0", private: true }));
  // Use the pinned Node's own npm so re2 fetches the prebuilt matching that ABI,
  // regardless of the ambient/runner Node version.
  const npmCli = firstExisting(
    join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"), // unix
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),        // windows
  );
  if (!npmCli) fail("could not locate npm in the pinned Node distribution");
  run(nodeBin, [npmCli, "install", `re2@${RE2_VERSION}`, "--no-audit", "--no-fund"], {
    cwd: re2tmp,
    env: { ...process.env, PATH: `${join(nodeDir, isWin ? "" : "bin")}${delimiter}${process.env.PATH}` },
  });
  const re2src = join(re2tmp, "node_modules", "re2");
  if (!existsSync(join(re2src, "build", "Release", "re2.node")))
    fail("re2 prebuilt not present after install (no prebuilt for this platform/ABI?)");
  cpSync(re2src, join(out, "runtime", "re2"), { recursive: true });

  // ── 6b. Bundled runtime: tree-sitter wasm grammars (poly-masker) ──────────────
  // The SEA bundle has no node_modules, so the web-tree-sitter core wasm and
  // one grammar per supported language ship next to the binary; the gateway
  // points the poly-masker at this directory (runtime.ts bundledWasmDir).
  step("runtime/wasm (web-tree-sitter core + poly grammars)");
  const wasmOut = join(out, "runtime", "wasm");
  mkdirSync(wasmOut, { recursive: true });
  const tsWasms = join(REPO, "node_modules", "tree-sitter-wasms", "out");
  for (const g of ["go", "java", "c_sharp", "kotlin", "python"]) {
    cpSync(join(tsWasms, `tree-sitter-${g}.wasm`), join(wasmOut, `tree-sitter-${g}.wasm`));
  }
  cpSync(
    join(REPO, "node_modules", "@unit-mesh", "treesitter-artifacts", "wasm", "tree-sitter-COBOL.wasm"),
    join(wasmOut, "tree-sitter-COBOL.wasm"),
  );
  const wtsDir = join(REPO, "node_modules", "web-tree-sitter");
  const coreWasm = firstExisting(join(wtsDir, "web-tree-sitter.wasm"), join(wtsDir, "tree-sitter.wasm"));
  if (!coreWasm) fail("web-tree-sitter core wasm not found in node_modules");
  cpSync(coreWasm, join(wasmOut, coreWasm.split(/[\\/]/).pop()));

  // ── 7. Bundled runtime: relocatable Python + sqlglot ─────────────────────────
  step("runtime/python (python-build-standalone + sqlglot)");
  const pyArchive = join(CACHE, `python-${platform}.tar.gz`);
  if (!existsSync(pyArchive)) {
    await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/${PY_CPYTHON}-${spec.py}-install_only.tar.gz`, pyArchive);
  }
  extract(pyArchive, join(out, "runtime"));
  const py = isWin
    ? join(out, "runtime", "python", "python.exe")
    : join(out, "runtime", "python", "bin", "python3");
  run(py, ["-m", "pip", "install", "--quiet", "sqlglot>=25,<31"]); // pure-Python, no per-OS compile

  console.error(`\n✓ built ${platform} → ${out}`);
  console.error(`  binary: wyloc${spec.exe}`);
  console.error(`  runtime: python+sqlglot, worker.py, re2 (raw-regex)`);
}

function tryRun(file, argv) { try { execFileSync(file, argv, { stdio: "ignore" }); } catch { /* best-effort */ } }
