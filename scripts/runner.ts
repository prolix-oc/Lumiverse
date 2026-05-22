#!/usr/bin/env bun
/**
 * Lumiverse Runner — Simplified terminal entry point.
 *
 * Spawns the backend server as a child process with IPC enabled.
 * Operator controls (update, restart, branch switch, etc.) are
 * handled via IPC from the web-based Operator panel.
 *
 * Terminal controls:
 *   O — Open browser
 *   Q / Ctrl+C — Graceful shutdown
 */

import { resolve } from "path";
import {
  startServer,
  stopServer,
  killServerSync,
  setIPCHandler,
  setStateChangeHandler,
  type ServerState,
} from "./runner/server-manager.js";
import { handleIPCMessage, setDevMode, setLastUpdateState, getLastUpdateState } from "./runner/ipc-handler.js";
import { checkForUpdates } from "./runner/git-ops.js";
import { readEnvConfig } from "./runner/env-config.js";
import { getCurrentBranch } from "./runner/lib/git.js";
import { UPDATE_CHECK_INTERVAL_MS } from "./runner/lib/constants.js";
import { goodbyeLines } from "./runner/goodbye-lines.js";

function pickRandomGoodbyeLine(lines: string[]): string {
  if (lines.length === 0) return "Goodbye.";
  const index = Math.floor(Math.random() * lines.length);
  return lines[index] ?? "Goodbye.";
}

// ─── Bun version gate ───────────────────────────────────────────────────────
// Checked before anything else so the operator sees a clear message.
{
  const [M = 0, m = 0, p = 0] = Bun.version.split(".").map(Number);
  if (M < 1 || (M === 1 && (m < 3 || (m === 3 && p < 3)))) {
    console.error(`\n  Bun ${Bun.version} is too old — Lumiverse requires Bun >= 1.3.3.`);
    console.error("  Update: curl -fsSL https://bun.sh/install | bash\n");
    process.exit(1);
  }
}

// ─── Parse arguments ────────────────────────────────────────────────────────

const isDev = process.argv.includes("--dev");
const autoOpen = process.argv.includes("--auto-open") || process.argv.includes("-a");
setDevMode(isDev);

// ─── Color helpers ──────────────────────────────────────────────────────────

const supportsColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY !== false;

const C = {
  bold: supportsColor ? "\x1b[1m" : "",
  dim: supportsColor ? "\x1b[2m" : "",
  cyan: supportsColor ? "\x1b[36m" : "",
  green: supportsColor ? "\x1b[32m" : "",
  yellow: supportsColor ? "\x1b[33m" : "",
  red: supportsColor ? "\x1b[31m" : "",
  reset: supportsColor ? "\x1b[0m" : "",
};

// ─── Banner ─────────────────────────────────────────────────────────────────

function printBanner(): void {
  const envConfig = readEnvConfig();
  const branch = getCurrentBranch() || "unknown";
  let version = "unknown";
  try {
    const pkg = require(resolve(import.meta.dir, "../package.json"));
    version = pkg.version;
  } catch {}

  console.log("");
  console.log(`${C.bold}  Lumiverse${C.reset} ${C.dim}v${version}${C.reset}`);
  console.log(`${C.dim}  Branch: ${C.reset}${branch}${isDev ? `${C.yellow} (dev)${C.reset}` : ""}`);
  console.log(`${C.dim}  Port:   ${C.reset}${envConfig.port}`);
  if (envConfig.trustAnyOrigin) {
    console.log(`${C.yellow}  Remote mode: ENABLED${C.reset}`);
  }
  console.log("");
  console.log(`${C.dim}  Press ${C.reset}O${C.dim} to open browser, ${C.reset}Q${C.dim} to quit${C.reset}`);
  console.log("");
}

// ─── Browser opener ─────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const opts = { stdout: "ignore" as const, stderr: "ignore" as const };
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], opts);
  } else if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], opts);
  } else {
    Bun.spawn(["xdg-open", url], opts);
  }
}

// ─── Keyboard input ─────────────────────────────────────────────────────────

function setupKeyboard(): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key: string) => {
    const code = key.charCodeAt(0);

    // Ctrl+C (0x03) or 'q'/'Q'
    if (code === 0x03 || key === "q" || key === "Q") {
      shutdown();
      return;
    }

    // 'o'/'O' — open browser
    if (key === "o" || key === "O") {
      const config = readEnvConfig();
      const url = `http://localhost:${config.port}`;
      console.log(`${C.dim}[runner]${C.reset} Opening ${url}...`);
      openBrowser(url);
      return;
    }
  });
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

let shuttingDown = false;
let openedAtStartup = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${C.dim}[runner]${C.reset} Shutting down...`);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  clearInterval(updateCheckInterval);
  await stopServer();

  console.log(`${C.dim}[runner]${C.reset} ${pickRandomGoodbyeLine(goodbyeLines)}`);
  process.exit(0);
}

// Signal handlers
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

// ─── State change handler ───────────────────────────────────────────────────

setStateChangeHandler((state: ServerState) => {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  switch (state) {
    case "running":
      console.log(`${C.dim}[${ts}]${C.reset} ${C.green}Server is running.${C.reset}`);
      if (autoOpen && !openedAtStartup) {
        openedAtStartup = true;
        const config = readEnvConfig();
        const url = `http://localhost:${config.port}`;
        console.log(`${C.dim}[runner]${C.reset} Opening ${url}...`);
        openBrowser(url);
      }
      break;
    case "crashed":
      console.log(`${C.dim}[${ts}]${C.reset} ${C.red}Server crashed. Waiting for operator action or restart.${C.reset}`);
      break;
    case "stopped":
      if (!shuttingDown) {
        console.log(`${C.dim}[${ts}]${C.reset} Server stopped.`);
      }
      break;
  }
});

// ─── IPC handler ────────────────────────────────────────────────────────────

setIPCHandler((msg) => {
  handleIPCMessage(msg).catch((err) => {
    console.error(`${C.dim}[runner]${C.reset} ${C.red}IPC error:${C.reset}`, err);
  });
});

// ─── Periodic update check ──────────────────────────────────────────────────

const updateCheckInterval = setInterval(async () => {
  try {
    const state = await checkForUpdates();
    setLastUpdateState(state);
  } catch {
    // Non-critical
  }
}, UPDATE_CHECK_INTERVAL_MS);

// Initial update check after 5s
setTimeout(async () => {
  try {
    const state = await checkForUpdates();
    setLastUpdateState(state);
  } catch {}
}, 5000);

// ─── Main ───────────────────────────────────────────────────────────────────

printBanner();
setupKeyboard();
startServer(isDev);
