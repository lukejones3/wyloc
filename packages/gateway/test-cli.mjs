/**
 * CLI setup/unsetup + service-definition tests.
 * Run with: node --import tsx test-cli.mjs
 */
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLaunchdPlist, renderSystemdUnit } from "./src/cli.ts";

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

const base = mkdtempSync(join(tmpdir(), "wyloc-cli-"));
const HOME = join(base, "home");
const STATE = join(base, "state");
mkdirSync(join(HOME, ".claude"), { recursive: true });
writeFileSync(join(HOME, ".claude", "settings.json"), JSON.stringify({ theme: "dark" })); // pre-existing
mkdirSync(join(HOME, ".codex"), { recursive: true });
// Pre-existing Codex config.toml — setup must MERGE openai_base_url, not clobber.
writeFileSync(join(HOME, ".codex", "config.toml"), 'model = "gpt-5-codex"\n\n[tools]\nweb_search = true\n');

const ENTRY = join(fileURLToPath(new URL(".", import.meta.url)), "src", "index.ts");
function wyloc(...args) {
  return execFileSync(process.execPath, ["--import", "tsx", ENTRY, ...args], {
    env: { ...process.env, HOME, WYLOC_STATE_DIR: STATE }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

// setup: detect Claude Code, wire it, preserve existing settings
wyloc("setup", "--yes");
const settings = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
ok("setup wired ANTHROPIC_BASE_URL", settings.env?.ANTHROPIC_BASE_URL?.startsWith("http://"));
ok("setup preserved existing settings", settings.theme === "dark");
ok("setup recorded state", existsSync(join(STATE, "setup-state.json")));

// Codex: setup writes config.toml openai_base_url, merging (not clobbering)
const codexToml = readFileSync(join(HOME, ".codex", "config.toml"), "utf8");
ok("codex: openai_base_url set in config.toml", /openai_base_url\s*=\s*"http:\/\//.test(codexToml));
ok("codex: existing 'model' preserved", /model\s*=\s*"gpt-5-codex"/.test(codexToml));
ok("codex: existing [tools] table preserved", /\[tools\]/.test(codexToml) && /web_search\s*=\s*true/.test(codexToml));
ok("codex: top-level key precedes the [tools] table (valid TOML)",
  codexToml.indexOf("openai_base_url") < codexToml.indexOf("[tools]"));

// idempotent: running again doesn't double up
wyloc("setup", "--yes");
const st = JSON.parse(readFileSync(join(STATE, "setup-state.json"), "utf8"));
ok("setup is idempotent (one change per tool)", st.changes.filter((c) => c.tool === "Claude Code").length === 1);

// unsetup: clean revert to the original file
wyloc("unsetup");
const reverted = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
ok("unsetup removed our key", reverted.env?.ANTHROPIC_BASE_URL === undefined);
ok("unsetup preserved the original", reverted.theme === "dark");
ok("unsetup cleared state", !existsSync(join(STATE, "setup-state.json")));

// Codex revert: config.toml restored to the original (no openai_base_url)
const codexReverted = readFileSync(join(HOME, ".codex", "config.toml"), "utf8");
ok("codex: unsetup removed openai_base_url", !/openai_base_url/.test(codexReverted));
ok("codex: unsetup preserved original config", /model\s*=\s*"gpt-5-codex"/.test(codexReverted) && /\[tools\]/.test(codexReverted));

// service definitions are well-formed and encode start-on-login + restart-on-crash
const plist = renderLaunchdPlist();
ok("launchd: RunAtLoad (start on login)", /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist));
ok("launchd: KeepAlive (restart on crash)", /<key>KeepAlive<\/key>\s*<true\/>/.test(plist));
ok("launchd: valid plist (plutil)", (() => {
  const f = join(base, "t.plist"); writeFileSync(f, plist);
  try { execFileSync("plutil", ["-lint", f], { stdio: "ignore" }); return true; } catch { return process.platform !== "darwin"; }
})());
const unit = renderSystemdUnit();
ok("systemd: Restart=always", /Restart=always/.test(unit));
ok("systemd: WantedBy=default.target (login)", /WantedBy=default.target/.test(unit));

console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
