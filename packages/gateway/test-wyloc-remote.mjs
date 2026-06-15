/**
 * Remote config-source tests (last-known-good + fail-closed floor).
 * Run with: node --import tsx test-wyloc-remote.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFromSource } from "./src/wyloc/remote.ts";
import { WylocConfigError } from "./src/wyloc/load.ts";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), "wyloc-remote-"));
const VALID = JSON.stringify({ version: 1, patterns: [{ name: "Employee ID", match: { type: "prefix", prefix: "EMP-", format: { kind: "digits", length: 6 } }, examples: { match: ["EMP-123456"] } }] });
const INVALID = JSON.stringify({ version: 1, patturns: [] });

let serve = VALID, reachable = true;
const srv = createServer((req, res) => { if (!reachable) { res.socket.destroy(); return; } res.writeHead(200, { "content-type": "application/json" }); res.end(serve); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/policy.json`;

function env(extra) { return { WYLOC_CONFIG_URL: url, WYLOC_CACHE_DIR: join(dir, "cache"), ...extra }; }
async function tryLoad(e) { try { return { r: await loadFromSource(e) }; } catch (err) { return { err }; } }

// 1. reachable + valid → loads + caches last-known-good
{
  const { r, err } = await tryLoad(env());
  ok("reachable+valid loads", !err && r.loaded && r.origin === "url", err && String(err.problems));
  ok("custom pattern compiled from URL", r?.loaded?.customPatterns?.length === 1);
  ok("last-known-good cached", existsSync(join(dir, "cache", "last-known-good.json")));
}

// 2. reachable + INVALID → fail-closed (cache NOT updated)
{
  serve = INVALID;
  const { err } = await tryLoad(env());
  ok("reachable+invalid fail-closed", err instanceof WylocConfigError && err.problems.some((p) => p.includes("did you mean")));
}

// 3. unreachable + cache → last-known-good (dev keeps working)
{
  reachable = false;
  const { r, err } = await tryLoad(env());
  ok("unreachable+cache uses last-known-good", !err && r.loaded && r.origin === "url-cache", err && String(err.problems || err));
  ok("cached policy still has the pattern", r?.loaded?.customPatterns?.length === 1);
}

// 4. unreachable + NO cache → fail-closed floor (never run with no policy)
{
  reachable = false;
  const { err } = await tryLoad(env({ WYLOC_CACHE_DIR: join(dir, "empty-cache") }));
  ok("unreachable+no-cache refuses to start", err instanceof WylocConfigError && err.problems.some((p) => /unreachable|no cached/.test(p)));
}

// 5. local file source still works (no URL)
{
  reachable = true;
  const p = join(dir, "local.json"); writeFileSync(p, VALID);
  const { r, err } = await tryLoad({ WYLOC_CONFIG: p }); // no URL → file source
  ok("local file source loads", !err && r.loaded && r.origin === "file");
}

srv.close();
console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
