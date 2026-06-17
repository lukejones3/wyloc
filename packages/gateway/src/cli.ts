/**
 * `wyloc` command-line surface for the standalone product.
 *
 *   wyloc                      run the gateway (default; same as `start`)
 *   wyloc start                run the gateway in the foreground
 *   wyloc setup [--yes]        detect Claude Code / Codex, show changes, wire them
 *   wyloc unsetup              revert everything `setup` changed
 *   wyloc service <cmd>        install|uninstall|start|stop|status|enable|disable
 *   wyloc status               gateway health + service status
 *   wyloc help | version
 *
 * setup is DETECT → SHOW → CONFIRM → APPLY, and records what it changed to a
 * state file so unsetup is a clean, exact revert.
 */

import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { loadConfig } from "./config.js";

const GATEWAY_URL = (() => {
  const c = loadConfig();
  return `http://${c.host}:${c.port}`;
})();

function configHome(): string {
  return process.env.WYLOC_STATE_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "wyloc");
}
const STATE_FILE = () => join(configHome(), "setup-state.json");

interface ToolChange { tool: string; file: string; format: "json" | "toml" | "yaml"; backup?: string; addedKeys?: string[]; }

// ── TOML top-level scalar helpers (no dependency; Codex config is TOML) ───────
// We only touch ONE top-level key (openai_base_url). Top-level keys must appear
// BEFORE any [table] header in TOML, so we insert/replace accordingly and back
// up the original for a verbatim revert.
function setTomlTopLevelString(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const newLine = `${key} = ${JSON.stringify(value)}`; // JSON string == valid TOML basic string
  for (let i = 0; i < lines.length; i++) {
    if ((firstTable === -1 || i < firstTable) && keyRe.test(lines[i]!)) {
      lines[i] = newLine; // replace existing top-level key
      return lines.join("\n");
    }
  }
  if (firstTable === -1) {
    const body = content.replace(/\s*$/, "");
    return (body ? body + "\n" : "") + newLine + "\n";
  }
  lines.splice(firstTable, 0, newLine, ""); // insert before the first table
  return lines.join("\n");
}
function removeTomlTopLevelKey(content: string, key: string): string {
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  return lines.filter((l, i) => !((firstTable === -1 || i < firstTable) && keyRe.test(l))).join("\n");
}

// ── YAML top-level scalar helpers (no dependency; aider's .aider.conf.yml) ─────
// We only touch ONE top-level key (openai-api-base). Top-level keys have no
// indentation, so matching `^key:` never disturbs nested mapping keys. The value
// is double-quoted (a valid YAML double-quoted scalar) so URLs with `:` are safe.
function setYamlTopLevelString(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const keyRe = new RegExp(`^${key}\\s*:`);
  const newLine = `${key}: ${JSON.stringify(value)}`; // JSON string == valid YAML double-quoted scalar
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i]!)) { lines[i] = newLine; return lines.join("\n"); } // replace existing top-level key
  }
  const body = content.replace(/\s*$/, "");
  return (body ? body + "\n" : "") + newLine + "\n";
}
function removeYamlTopLevelKey(content: string, key: string): string {
  const keyRe = new RegExp(`^${key}\\s*:`);
  return content.split(/\r?\n/).filter((l) => !keyRe.test(l)).join("\n");
}
interface SetupState { url: string; changes: ToolChange[]; }

function readState(): SetupState | null {
  const f = STATE_FILE();
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
function writeState(s: SetupState): void {
  mkdirSync(configHome(), { recursive: true });
  writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
}

async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await new Promise<string>((res) => rl.question(`${question} [y/N] `, res));
    return /^y(es)?$/i.test(a.trim());
  } finally { rl.close(); }
}

// ── Tool adapters ────────────────────────────────────────────────────────────

interface AiTool {
  name: string;
  /** Detected installed on this machine? */
  detect(): boolean;
  /** Human description of the change setup would make. */
  plan(url: string): string;
  /** Apply; return the ToolChange to record for revert. */
  apply(url: string): ToolChange;
  /** Optional caveat printed during setup (e.g. partial-protection warning). */
  note?: string;
}

/** Claude Code: settings.json `env.ANTHROPIC_BASE_URL`. Robust + shell-independent. */
const claudeCode: AiTool = {
  name: "Claude Code",
  detect() {
    return existsSync(join(homedir(), ".claude")) || onPath("claude");
  },
  plan(url) {
    const f = join(homedir(), ".claude", "settings.json");
    return `Claude Code → set env.ANTHROPIC_BASE_URL = ${url} in ${f}`;
  },
  apply(url) {
    const f = join(homedir(), ".claude", "settings.json");
    mkdirSync(dirname(f), { recursive: true });
    const backup = existsSync(f) ? backupOf(f) : undefined;
    const json = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    json.env = json.env && typeof json.env === "object" ? json.env : {};
    json.env.ANTHROPIC_BASE_URL = url;
    writeFileSync(f, JSON.stringify(json, null, 2));
    return { tool: this.name, file: f, format: "json", ...(backup ? { backup } : { addedKeys: ["env.ANTHROPIC_BASE_URL"] }) };
  },
};

/**
 * Codex: the CLI reads `~/.codex/config.toml`; the top-level `openai_base_url`
 * key overrides the built-in `openai` provider's base URL (verified against the
 * official Codex config reference). Codex does NOT read an OPENAI_BASE_URL env
 * var, so the previous settings.json/env approach was a no-op.
 */
const codex: AiTool = {
  name: "Codex",
  detect() {
    return existsSync(join(homedir(), ".codex")) || onPath("codex");
  },
  plan(url) {
    const f = join(homedir(), ".codex", "config.toml");
    return `Codex → set openai_base_url = "${url}" in ${f}`;
  },
  apply(url) {
    const f = join(homedir(), ".codex", "config.toml");
    mkdirSync(dirname(f), { recursive: true });
    const existed = existsSync(f);
    const backup = existed ? backupOf(f) : undefined;
    const original = existed ? readFileSync(f, "utf8") : "";
    writeFileSync(f, setTomlTopLevelString(original, "openai_base_url", url));
    return { tool: this.name, file: f, format: "toml", ...(backup ? { backup } : { addedKeys: ["openai_base_url"] }) };
  },
  // HONEST caveat — Codex's wire API is the Responses API (/v1/responses), which
  // the gateway currently FORWARDS UNMASKED. Routing is correct, but masking is
  // not yet in place, so don't treat Codex as protected until the gateway masks
  // the Responses API.
  note:
    "Codex talks to the OpenAI Responses API (/v1/responses), which WYLOC does NOT yet mask — " +
    "with setup applied, Codex routes through the gateway but its traffic is currently FORWARDED UNMASKED. " +
    "Full Codex protection requires gateway Responses-API masking (not yet implemented).",
};

/**
 * Aider: reads `.aider.conf.yml` (home dir, repo root, or cwd); the top-level
 * `openai-api-base` key sets the OpenAI-compatible base URL (doc-confirmed
 * against aider's config reference). Aider talks the Chat Completions wire
 * format, which the gateway MASKS — so unlike Codex this is real protection.
 * We write the home-directory copy (the machine-wide default).
 *
 * The base URL gets a `/v1` suffix: aider/OpenAI clients append
 * `/chat/completions`, and the gateway routes `/v1/chat/completions`.
 */
const aider: AiTool = {
  name: "Aider",
  detect() {
    return existsSync(join(homedir(), ".aider.conf.yml")) || onPath("aider");
  },
  plan(url) {
    const f = join(homedir(), ".aider.conf.yml");
    return `Aider → set openai-api-base: "${url}/v1" in ${f}`;
  },
  apply(url) {
    const f = join(homedir(), ".aider.conf.yml");
    mkdirSync(dirname(f), { recursive: true });
    const existed = existsSync(f);
    const backup = existed ? backupOf(f) : undefined;
    const original = existed ? readFileSync(f, "utf8") : "";
    writeFileSync(f, setYamlTopLevelString(original, "openai-api-base", `${url}/v1`));
    return { tool: this.name, file: f, format: "yaml", ...(backup ? { backup } : { addedKeys: ["openai-api-base"] }) };
  },
  // Aider's Chat Completions traffic IS masked. The remaining caveat is routing:
  // the gateway forwards Chat Completions to ONE configured OpenAI upstream
  // (api.openai.com by default). Point it elsewhere with WYLOC_OPENAI_UPSTREAM_BASE_URL
  // if you use a non-OpenAI OpenAI-compatible backend. Use an OpenAI-style model
  // so aider actually routes through openai-api-base.
  note:
    "Aider speaks the OpenAI Chat Completions API, which WYLOC masks (real protection, unlike Codex). " +
    "The gateway forwards Chat Completions to its single OpenAI upstream (api.openai.com by default; set " +
    "WYLOC_OPENAI_UPSTREAM_BASE_URL for another OpenAI-compatible backend). Use an OpenAI-style model so " +
    "aider routes through openai-api-base.",
};

const TOOLS = [claudeCode, codex, aider];

function onPath(bin: string): boolean {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
function backupOf(f: string): string {
  const b = `${f}.wyloc-backup`;
  copyFileSync(f, b);
  return b;
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdSetup(args: string[]): Promise<void> {
  const assumeYes = args.includes("--yes") || args.includes("-y");
  const detected = TOOLS.filter((t) => t.detect());
  if (detected.length === 0) {
    console.error("No supported AI tools detected (Claude Code, Codex, Aider). Nothing to do.");
    return;
  }
  console.error(`Wyloc gateway: ${GATEWAY_URL}\n\nThis will make the following changes:`);
  for (const t of detected) console.error(`  • ${t.plan(GATEWAY_URL)}`);
  const notes = detected.filter((t) => t.note);
  if (notes.length > 0) {
    console.error("\n⚠  Important:");
    for (const t of notes) console.error(`  • ${t.name}: ${t.note}`);
  }
  console.error("");
  if (!(await confirm("Apply these changes?", assumeYes))) { console.error("Aborted. No changes made."); return; }

  const prior = readState();
  const changes: ToolChange[] = prior?.changes ?? [];
  for (const t of detected) {
    if (changes.some((c) => c.tool === t.name)) continue; // already set up
    changes.push(t.apply(GATEWAY_URL));
    console.error(`  ✓ ${t.name} pointed at the gateway`);
  }
  writeState({ url: GATEWAY_URL, changes });
  console.error(`\nDone. Start a FRESH ${detected.map((t) => t.name).join(" / ")} session to pick up the change.`);
  console.error(`Revert anytime with:  wyloc unsetup`);
}

function cmdUnsetup(): void {
  const state = readState();
  if (!state || state.changes.length === 0) { console.error("Nothing to revert (no setup state found)."); return; }
  for (const c of state.changes) {
    try {
      if (c.backup && existsSync(c.backup)) {
        copyFileSync(c.backup, c.file); rmSync(c.backup, { force: true });
      } else if (c.addedKeys && existsSync(c.file)) {
        // We created the file (no backup) — remove only our keys, format-aware.
        if (c.format === "toml" || c.format === "yaml") {
          let content = readFileSync(c.file, "utf8");
          for (const k of c.addedKeys) {
            content = c.format === "toml" ? removeTomlTopLevelKey(content, k) : removeYamlTopLevelKey(content, k);
          }
          if (content.trim() === "") rmSync(c.file, { force: true });
          else writeFileSync(c.file, content);
        } else {
          const json = JSON.parse(readFileSync(c.file, "utf8"));
          for (const k of c.addedKeys) {
            const [outer, inner] = k.split(".");
            if (inner && json[outer!]) {
              delete json[outer!][inner];
              if (Object.keys(json[outer!]).length === 0) delete json[outer!];
            } else delete json[k];
          }
          if (Object.keys(json).length === 0) rmSync(c.file, { force: true });
          else writeFileSync(c.file, JSON.stringify(json, null, 2));
        }
      }
      console.error(`  ✓ reverted ${c.tool}`);
    } catch (e) {
      console.error(`  ✗ could not fully revert ${c.tool}: ${(e as Error).message}`);
    }
  }
  rmSync(STATE_FILE(), { force: true });
  console.error("\nReverted. Start a fresh session to drop the gateway.");
}

// ── Service (daemon) ─────────────────────────────────────────────────────────

const SERVICE_LABEL = "com.wyloc.gateway";

function launchdPlistPath(): string { return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`); }
function systemdUnitPath(): string { return join(homedir(), ".config", "systemd", "user", "wyloc-gateway.service"); }

function selfPath(): string { return process.execPath.includes("node") ? `${process.execPath} ${process.argv[1]}` : process.execPath; }

export function renderLaunchdPlist(): string {
  const [prog, ...progArgs] = selfPath().split(" ");
  const args = [prog, ...progArgs, "start"].map((a) => `    <string>${a}</string>`).join("\n");
  const logDir = join(homedir(), "Library", "Logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "wyloc-gateway.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "wyloc-gateway.log")}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(): string {
  return `[Unit]
Description=Wyloc DLP gateway
After=network.target

[Service]
ExecStart=${selfPath()} start
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function cmdService(args: string[]): void {
  const sub = args[0];
  const os = platform();
  const launchctl = (...a: string[]) => execFileSync("launchctl", a, { stdio: "inherit" });
  const systemctl = (...a: string[]) => execFileSync("systemctl", ["--user", ...a], { stdio: "inherit" });

  if (os === "darwin") {
    const plist = launchdPlistPath();
    switch (sub) {
      case "install": case "enable": {
        mkdirSync(dirname(plist), { recursive: true });
        writeFileSync(plist, renderLaunchdPlist());
        try { launchctl("unload", plist); } catch {}
        launchctl("load", plist);
        console.error(`✓ launchd agent installed + loaded (${plist}) — starts on login, restarts on crash.`); break;
      }
      case "uninstall": case "disable": {
        try { launchctl("unload", plist); } catch {}
        rmSync(plist, { force: true }); console.error("✓ launchd agent removed."); break;
      }
      case "start": launchctl("start", SERVICE_LABEL); console.error("✓ started"); break;
      case "stop": launchctl("stop", SERVICE_LABEL); console.error("✓ stopped"); break;
      case "status": try { launchctl("list", SERVICE_LABEL); } catch { console.error("not loaded"); } break;
      default: serviceUsage();
    }
    return;
  }
  if (os === "linux") {
    const unit = systemdUnitPath();
    switch (sub) {
      case "install": case "enable": {
        mkdirSync(dirname(unit), { recursive: true });
        writeFileSync(unit, renderSystemdUnit());
        systemctl("daemon-reload"); systemctl("enable", "--now", "wyloc-gateway.service");
        console.error(`✓ systemd user service installed + enabled (${unit}) — starts on login, restarts on crash.`); break;
      }
      case "uninstall": case "disable": {
        try { systemctl("disable", "--now", "wyloc-gateway.service"); } catch {}
        rmSync(unit, { force: true }); systemctl("daemon-reload"); console.error("✓ systemd service removed."); break;
      }
      case "start": systemctl("start", "wyloc-gateway.service"); break;
      case "stop": systemctl("stop", "wyloc-gateway.service"); break;
      case "status": try { systemctl("status", "wyloc-gateway.service"); } catch {} break;
      default: serviceUsage();
    }
    return;
  }
  console.error(`Service management on ${os} is not yet automated. Run \`wyloc start\` (or use a Windows Scheduled Task / NSSM pointing at the binary with \`start\`).`);
}

function serviceUsage(): void {
  console.error("usage: wyloc service <install|uninstall|start|stop|status|enable|disable>");
}

async function cmdStatus(): Promise<void> {
  try {
    const res = await fetch(`${GATEWAY_URL}/healthz`);
    const body = await res.json().catch(() => ({}));
    console.error(`gateway: UP at ${GATEWAY_URL} (${JSON.stringify(body)})`);
  } catch {
    console.error(`gateway: DOWN (no response at ${GATEWAY_URL}). Start it with \`wyloc start\` or \`wyloc service install\`.`);
  }
  const state = readState();
  console.error(state ? `setup: ${state.changes.map((c) => c.tool).join(", ")} pointed at ${state.url}` : "setup: not configured (run `wyloc setup`)");
}

function help(): void {
  console.error(`wyloc — prompt-time DLP gateway

  wyloc [start]            run the gateway (foreground)
  wyloc setup [--yes]      point installed AI tools (Claude Code, Codex, Aider) at the gateway
  wyloc unsetup            revert what setup changed
  wyloc service <cmd>      install|uninstall|start|stop|status|enable|disable (launchd/systemd)
  wyloc status             gateway health + setup status
  wyloc help | version

  gateway URL: ${GATEWAY_URL}`);
}

/** Returns true if this invocation was a CLI command (handled here), false to run the gateway. */
export async function runCli(argv: string[]): Promise<boolean> {
  const cmd = argv[0];
  switch (cmd) {
    case undefined: case "start": return false; // run the gateway
    case "setup": await cmdSetup(argv.slice(1)); return true;
    case "unsetup": cmdUnsetup(); return true;
    case "service": cmdService(argv.slice(1)); return true;
    case "status": await cmdStatus(); return true;
    case "version": case "--version": case "-v":
      console.error(loadConfigVersion()); return true;
    case "help": case "--help": case "-h": help(); return true;
    default:
      console.error(`unknown command: ${cmd}\n`); help(); process.exitCode = 1; return true;
  }
}

function loadConfigVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return `wyloc ${pkg.version}`;
  } catch { return "wyloc"; }
}
