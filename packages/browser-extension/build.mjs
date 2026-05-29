/**
 * Build script for the browser extension.
 *
 * esbuild bundles each entry point into a single self-contained file
 * with @ai-dlp/detector inlined — content scripts cannot use bare
 * imports, so everything must be bundled. Output goes to `dist/`, which
 * is the unpacked extension you load into Chrome.
 *
 *   node build.mjs           one-off build
 *   node build.mjs --watch   rebuild on change
 */

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

// Resolve the detector's TypeScript source so esbuild bundles it directly.
// This means a `src/` edit in @wyloc/detector is picked up by a single
// `npm run build --workspace @wyloc/browser-extension` without a separate
// detector rebuild step.
const detectorSrc = new URL("../detector/src/index.ts", import.meta.url).pathname;

const watch = process.argv.includes("--watch");
const outdir = "dist";

const entryPoints = {
  content: "src/content.ts",
  background: "src/background.ts",
  popup: "src/popup.ts",
  inject: "src/inject.ts",
};

/** Files copied verbatim into dist/. */
const staticAssets = [
  "manifest.json",
  "popup.html",
  "content.css",
  "icons",
];

const buildOptions = {
  entryPoints,
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome111",
  // Content scripts run in an isolated world; keep names readable for
  // store review while still stripping dead code.
  minify: false,
  sourcemap: false,
  legalComments: "none",
  alias: {
    "@wyloc/detector": detectorSrc,
  },
};

async function copyStatic() {
  for (const asset of staticAssets) {
    try {
      await cp(asset, `${outdir}/${asset}`, { recursive: true });
    } catch {
      // icons/ may not exist yet during early dev — non-fatal.
      if (asset !== "icons") {
        console.warn(`warning: could not copy ${asset}`);
      }
    }
  }
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatic();
    console.log("watching… (static assets copied once; re-run for asset changes)");
  } else {
    await esbuild.build(buildOptions);
    await copyStatic();
    console.log(`built -> ${outdir}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
