#!/usr/bin/env node
/**
 * Build the standalone Wyloc gateway distribution for one platform.
 *
 *   node scripts/build-binary.mjs [--platform <key>] [--out <dir>] [--no-runtime]
 *
 * Produces:  <out>/<platform>/
 *   wyloc                       ← Node SEA binary (pinned Node 22 LTS)
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
 * Cross-platform builds run this on each target OS in CI (codesign on macOS,
 * signtool on Windows). Pure-Python sqlglot needs no per-OS compile; re2 and
 * python-build-standalone provide per-platform prebuilts.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

const GATEWAY = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO = resolve(GATEWAY, "..", "..");

// ── Pins ────────────────────────────────────────────────────────────────────
const NODE_VERSION = "22.14.0";
const RE2_VERSION = "1.21.4";
const PY_TAG = "20250115";
const PY_CPYTHON = "cpython-3.12.8+20250115";

/** Per-platform artifact coordinates. */
const PLATFORMS = {
  "darwin-arm64": { node: "darwin-arm64", py: "aarch64-apple-darwin", exe: "", sign: "codesign" },
  "darwin-x64": { node: "darwin-x64", py: "x86_64-apple-darwin", exe: "", sign: "codesign" },
  "linux-x64": { node: "linux-x64", py: "x86_64-unknown-linux-gnu", exe: "", sign: null },
  "linux-arm64": { node: "linux-arm64", py: "aarch64-unknown-linux-gnu", exe: "", sign: null },
  "win-x64": { node: "win-x64", py: "x86_64-pc-windows-msvc", exe: ".exe", sign: "signtool" },
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
if (!spec) { fail(`unknown platform ${platform}; one of: ${Object.keys(PLATFORMS).join(", ")}`); }
const isHost = platform === hostPlatform();

const CACHE = join(homedir(), ".cache", "wyloc-build");
mkdirSync(CACHE, { recursive: true });
const out = join(outRoot, platform);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "runtime"), { recursive: true });

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const shOut = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
function fail(msg) { console.error(`\n✗ build-binary: ${msg}\n`); process.exit(1); }
function step(msg) { console.error(`\n▸ ${msg}`); }

// ── 1. Pinned Node 22 LTS (official monolithic) ──────────────────────────────
step(`Node ${NODE_VERSION} (${spec.node})`);
const nodeDir = join(CACHE, `node-v${NODE_VERSION}-${spec.node}`);
const nodeBin = platform.startsWith("win")
  ? join(nodeDir, "node.exe")
  : join(nodeDir, "bin", "node");
if (!existsSync(nodeBin)) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${spec.node}`;
  if (platform.startsWith("win")) {
    sh(`curl -sL "${base}.zip" -o "${nodeDir}.zip" && unzip -q -o "${nodeDir}.zip" -d "${CACHE}"`);
  } else {
    sh(`curl -sL "${base}.tar.gz" | tar xz -C "${CACHE}"`);
  }
}
if (!existsSync(nodeBin)) fail(`Node binary not found at ${nodeBin}`);

// ── 2. Build workspaces + esbuild bundle (ESM→CJS, import.meta shim) ─────────
step("build workspaces + bundle");
sh(`npm run build --silent`, { cwd: REPO });
const esbuild = join(REPO, "node_modules", ".bin", "esbuild");
const bundle = join(CACHE, "gateway.cjs");
sh([
  `"${esbuild}" "${join(GATEWAY, "dist", "index.js")}"`,
  `--bundle --platform=node --format=cjs --target=node22 --external:re2`,
  `'--banner:js=const _importMetaUrl=require("url").pathToFileURL(__filename).href;'`,
  `'--define:import.meta.url=_importMetaUrl'`,
  `--outfile="${bundle}"`,
].join(" "));
// Strip the shebang — invalid as the first line of a SEA blob (parsed as JS).
const stripped = join(CACHE, "gateway.sea.cjs");
writeFileSync(stripped, readFileSync(bundle, "utf8").replace(/^#![^\n]*\n/, ""));

// ── 3. SEA blob (generated by the SAME pinned Node) ──────────────────────────
step("SEA blob");
const seaCfg = join(CACHE, "sea-config.json");
const blob = join(CACHE, "gateway.blob");
writeFileSync(seaCfg, JSON.stringify({ main: stripped, output: blob }));
sh(`"${nodeBin}" --experimental-sea-config "${seaCfg}"`);

// ── 4. Inject into a copy of the Node binary ─────────────────────────────────
step("assemble binary");
const exeName = `wyloc${spec.exe}`;
const exe = join(out, exeName);
cpSync(nodeBin, exe); chmodSync(exe, 0o755);
const fuse = shOut(`strings -a "${nodeBin}" | grep -oE "NODE_SEA_FUSE_[0-9a-f]+" | head -1`);
if (!fuse) fail("could not read SEA fuse sentinel from the Node binary");
if (spec.sign === "codesign") sh(`codesign --remove-signature "${exe}" || true`);
const postject = join(REPO, "node_modules", ".bin", "postject");
const seg = spec.node.startsWith("darwin") ? `--macho-segment-name NODE_SEA` : "";
sh(`npx -y postject "${exe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${fuse} ${seg}`);
if (spec.sign === "codesign") sh(`codesign --sign - "${exe}" || true`);
// (Windows: sign with signtool in CI; Linux: no signing needed.)

if (!withRuntime) { console.error(`\n✓ binary only: ${exe}\n`); process.exit(0); }

// ── 5. Bundled runtime: worker.py ────────────────────────────────────────────
step("runtime/sql/worker.py");
mkdirSync(join(out, "runtime", "sql"), { recursive: true });
cpSync(join(REPO, "packages", "sql-masker", "python", "worker.py"), join(out, "runtime", "sql", "worker.py"));

// ── 6. Bundled runtime: RE2 prebuilt (installed under the pinned Node) ────────
step(`runtime/re2 (re2 ${RE2_VERSION} prebuilt)`);
if (isHost) {
  const re2tmp = join(CACHE, "re2-install");
  rmSync(re2tmp, { recursive: true, force: true }); mkdirSync(re2tmp, { recursive: true });
  writeFileSync(join(re2tmp, "package.json"), JSON.stringify({ name: "r", version: "1.0.0", private: true }));
  // Install with the PINNED Node's npm so re2 fetches the prebuilt for that ABI.
  sh(`npm install re2@${RE2_VERSION} --no-audit --no-fund`, {
    cwd: re2tmp,
    env: { ...process.env, PATH: `${dirname(nodeBin)}:${process.env.PATH}` },
  });
  cpSync(join(re2tmp, "node_modules", "re2"), join(out, "runtime", "re2"), { recursive: true });
} else {
  console.error("  cross-platform re2: fetch the prebuilt .br for the target ABI in CI (run on target OS).");
}

// ── 7. Bundled runtime: relocatable Python + sqlglot ─────────────────────────
step("runtime/python (python-build-standalone + sqlglot)");
const pyArchive = join(CACHE, `python-${platform}.tar.gz`);
if (!existsSync(pyArchive)) {
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/${PY_CPYTHON}-${spec.py}-install_only.tar.gz`;
  sh(`curl -sL "${url}" -o "${pyArchive}"`);
}
sh(`tar xz -C "${join(out, "runtime")}" -f "${pyArchive}"`);
const py = platform.startsWith("win")
  ? join(out, "runtime", "python", "python.exe")
  : join(out, "runtime", "python", "bin", "python3");
// sqlglot is pure-Python — installs the same regardless of host OS.
sh(`"${py}" -m pip install --quiet "sqlglot>=25,<31"`);

console.error(`\n✓ built ${platform} → ${out}`);
console.error(`  binary: ${exeName}`);
console.error(`  runtime: python+sqlglot, worker.py, re2 (raw-regex)`);
