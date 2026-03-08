#!/usr/bin/env bun
/**
 * Lumiverse Visual Runner
 *
 * A terminal dashboard that spawns the backend as a child process and
 * provides real-time log viewing, status monitoring, and process control.
 *
 * Usage:
 *   bun run runner
 *   bun run scripts/runner.ts [-- --dev]
 *
 * Keyboard:
 *   R - Restart server
 *   U - Update from GitHub (when available)
 *   O - Open in browser
 *   C - Clear log
 *   Q / Ctrl+C - Quit
 */

import { resolve, join } from "path";
import { existsSync } from "fs";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(PROJECT_ROOT, "src/index.ts");
const ENV_FILE = join(PROJECT_ROOT, ".env");

const isDev = process.argv.includes("--dev");

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ansi = {
  altScreenOn:   `${CSI}?1049h`,
  altScreenOff:  `${CSI}?1049l`,
  cursorHide:    `${CSI}?25l`,
  cursorShow:    `${CSI}?25h`,
  clearScreen:   `${CSI}2J`,
  clearScrollback: `${CSI}3J`,
  clearLine:     `${CSI}2K`,
  home:          `${CSI}H`,
  moveTo:        (r: number, c: number) => `${CSI}${r};${c}H`,
  setScrollRegion: (top: number, bot: number) => `${CSI}${top};${bot}r`,
  resetScrollRegion: `${CSI}r`,
  bold:          `${CSI}1m`,
  dim:           `${CSI}2m`,
  reset:         `${CSI}0m`,
  fg: (n: number) => `${CSI}38;5;${n}m`,
  bg: (n: number) => `${CSI}48;5;${n}m`,
};

// Theme (matches ui.ts)
const C = {
  purple:  ansi.fg(141),
  blue:    ansi.fg(75),
  cyan:    ansi.fg(117),
  green:   ansi.fg(114),
  yellow:  ansi.fg(221),
  red:     ansi.fg(204),
  gray:    ansi.fg(245),
  white:   ansi.fg(255),
  darkGray: ansi.fg(238),
  bgBar:   ansi.bg(236),
  R:       ansi.reset,
};

// ─── Terminal I/O ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Write raw escape sequences synchronously via Bun's native I/O. */
function rawWrite(data: string): void {
  Bun.write(Bun.stdout, encoder.encode(data));
}

/** Enter the alternate screen buffer with a clean slate. */
function enterAltScreen(): void {
  // Clear main buffer scrollback first — prevents macOS Terminal.app from
  // letting the user scroll up past the TUI into old shell history.
  rawWrite(ansi.clearScrollback);
  // Switch to alternate screen buffer (saves main buffer for restore on exit)
  rawWrite(ansi.altScreenOn);
  // Clear the alternate screen and park cursor at 1,1
  rawWrite(ansi.clearScreen + ansi.home);
  // Lock scroll region to the visible area — prevents any scrollback from
  // accumulating in the alternate buffer.
  rawWrite(ansi.setScrollRegion(1, rows));
  // Hide the cursor for the TUI
  rawWrite(ansi.cursorHide);
}

/** Leave the alternate screen buffer and restore the main buffer. */
function leaveAltScreen(): void {
  rawWrite(ansi.resetScrollRegion + ansi.cursorShow + ansi.altScreenOff);
}

// ─── Terminal size ──────────────────────────────────────────────────────────

let cols = process.stdout.columns || 80;
let rows = process.stdout.rows || 24;

process.stdout.on?.("resize", () => {
  cols = process.stdout.columns || 80;
  rows = process.stdout.rows || 24;
  // Reapply scroll region to match new terminal size
  rawWrite(ansi.setScrollRegion(1, rows));
  render();
});

// ─── State ──────────────────────────────────────────────────────────────────

type ServerState = "starting" | "running" | "stopping" | "stopped" | "crashed";

let state: ServerState = "stopped";
let serverPid: number | null = null;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let startedAt: number | null = null;
let restartCount = 0;
let port = 7860;

// Log buffer
const MAX_LOG_LINES = 2000;
const logLines: string[] = [];
let logScrollOffset = 0; // 0 = follow tail

// Update state
let updateAvailable = false;
let updateCommitsBehind = 0;
let updateLatestMessage = "";
let updateChecking = false;
let updateInProgress = false;
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Load port from .env
if (existsSync(ENV_FILE)) {
  const envContent = await Bun.file(ENV_FILE).text();
  const portMatch = envContent.match(/^PORT=(\d+)/m);
  if (portMatch) port = parseInt(portMatch[1], 10);
}

// ─── Log management ─────────────────────────────────────────────────────────

function addLog(line: string, source: "stdout" | "stderr" | "system" = "stdout"): void {
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  let prefix: string;
  switch (source) {
    case "stderr":  prefix = `${C.gray}${ts} ${C.red}ERR${C.R}`; break;
    case "system":  prefix = `${C.gray}${ts} ${C.blue}SYS${C.R}`; break;
    default:        prefix = `${C.gray}${ts} ${C.darkGray}   ${C.R}`; break;
  }

  // Handle multiline output
  const lines = line.split("\n");
  for (const l of lines) {
    if (l.trim() === "") continue;
    logLines.push(`${prefix} ${l}`);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
  }

  if (logScrollOffset === 0) render(); // auto-render when following tail
}

// ─── Process management ─────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  if (serverProc) return;

  state = "starting";
  startedAt = Date.now();
  addLog("Starting Lumiverse Backend...", "system");
  render();

  const args = isDev
    ? ["bun", "run", "--watch", ENTRY]
    : ["bun", "run", ENTRY];

  serverProc = Bun.spawn(args, {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Force color output in child
      FORCE_COLOR: "1",
    },
  });

  serverPid = serverProc.pid;

  // Stream stdout
  if (serverProc.stdout) {
    streamReader(serverProc.stdout, "stdout");
  }

  // Stream stderr
  if (serverProc.stderr) {
    streamReader(serverProc.stderr, "stderr");
  }

  // Wait for process exit
  serverProc.exited.then((code) => {
    const wasRunning = state === "running" || state === "starting";
    serverProc = null;
    serverPid = null;

    if (state === "stopping") {
      state = "stopped";
      addLog("Server stopped.", "system");
    } else if (code !== 0) {
      state = "crashed";
      addLog(`Server exited with code ${code}`, "system");
    } else {
      state = "stopped";
      addLog("Server exited.", "system");
    }
    render();
  });

  // Assume running after brief delay (no health check endpoint yet)
  setTimeout(() => {
    if (state === "starting") {
      state = "running";
      render();
    }
  }, 2000);
}

async function streamReader(stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr"): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // Detect "starting on port" to confirm running state
        if (line.includes("starting on port") && state === "starting") {
          state = "running";
        }
        addLog(line, source);
      }
    }
    // Flush remaining
    if (buffer.trim()) addLog(buffer, source);
  } catch {
    // Stream closed
  }
}

async function stopServer(): Promise<void> {
  if (!serverProc) return;

  state = "stopping";
  addLog("Stopping server...", "system");
  render();

  serverProc.kill("SIGTERM");

  // Force kill after 5s
  const timeout = setTimeout(() => {
    if (serverProc) {
      addLog("Force killing server (timeout)...", "system");
      serverProc.kill("SIGKILL");
    }
  }, 5000);

  await serverProc.exited;
  clearTimeout(timeout);
}

async function restartServer(): Promise<void> {
  restartCount++;
  addLog(`Restarting server (restart #${restartCount})...`, "system");
  await stopServer();
  await startServer();
}

// ─── Update checking ────────────────────────────────────────────────────────

function runGit(...args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
  };
}

async function checkForUpdates(): Promise<void> {
  if (updateChecking || updateInProgress) return;

  // Verify we're in a git repo with a remote
  const remote = runGit("remote");
  if (!remote.ok || !remote.out) return;

  updateChecking = true;
  render();

  // Fetch in the background so we don't block
  const fetchProc = Bun.spawn(["git", "fetch", "--quiet"], {
    cwd: PROJECT_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  await fetchProc.exited;

  // Get the tracking branch (e.g. origin/main)
  const upstream = runGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (!upstream.ok) {
    updateChecking = false;
    render();
    return;
  }

  // Count commits behind
  const revList = runGit("rev-list", "--count", `HEAD..${upstream.out}`);
  if (!revList.ok) {
    updateChecking = false;
    render();
    return;
  }

  const behind = parseInt(revList.out, 10);
  if (behind > 0) {
    // Get the latest remote commit message
    const logMsg = runGit("log", "--format=%s", "-1", upstream.out);
    updateAvailable = true;
    updateCommitsBehind = behind;
    updateLatestMessage = logMsg.ok ? logMsg.out : "";
    addLog(`Update available: ${behind} commit${behind > 1 ? "s" : ""} behind`, "system");
    if (updateLatestMessage) {
      addLog(`  Latest: ${updateLatestMessage}`, "system");
    }
  } else {
    updateAvailable = false;
    updateCommitsBehind = 0;
    updateLatestMessage = "";
  }

  updateChecking = false;
  render();
}

async function applyUpdate(): Promise<void> {
  if (!updateAvailable || updateInProgress) return;
  updateInProgress = true;
  render();

  addLog("Pulling latest changes...", "system");

  // Check for uncommitted changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    addLog("Stashing local changes...", "system");
    runGit("stash", "push", "-m", "lumiverse-runner-auto-stash");
  }

  // Pull
  const pullProc = Bun.spawn(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const pullOut = await new Response(pullProc.stdout).text();
  const pullErr = await new Response(pullProc.stderr).text();
  const pullCode = await pullProc.exited;

  if (pullCode !== 0) {
    addLog(`Update failed: ${pullErr.trim() || pullOut.trim()}`, "system");
    updateInProgress = false;
    render();
    return;
  }

  for (const line of pullOut.trim().split("\n")) {
    if (line.trim()) addLog(`  ${line.trim()}`, "system");
  }

  // Check which files changed to decide what needs rebuilding
  const diffFiles = runGit("diff", "--name-only", "HEAD@{1}", "HEAD");
  const changedFiles = diffFiles.ok ? diffFiles.out : "";

  // Reinstall backend dependencies if package.json changed
  if (changedFiles.includes("package.json")) {
    addLog("package.json changed — reinstalling backend dependencies...", "system");
    const installProc = Bun.spawn(["bun", "install"], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await installProc.exited;
    addLog("Backend dependencies updated.", "system");
  }

  // Rebuild frontend if any frontend files changed
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendChanged = changedFiles.split("\n").some((f) => f.startsWith("frontend/"));

  if (frontendChanged) {
    // Reinstall frontend dependencies if its package.json changed
    if (changedFiles.includes("frontend/package.json")) {
      addLog("frontend/package.json changed — reinstalling frontend dependencies...", "system");
      const feInstallProc = Bun.spawn(["bun", "install"], {
        cwd: frontendDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await feInstallProc.exited;
      addLog("Frontend dependencies updated.", "system");
    }

    addLog("Frontend files changed — rebuilding frontend...", "system");
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: frontendDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildOut = await new Response(buildProc.stdout).text();
    const buildErr = await new Response(buildProc.stderr).text();
    const buildCode = await buildProc.exited;

    if (buildCode !== 0) {
      addLog(`Frontend build failed: ${buildErr.trim() || buildOut.trim()}`, "system");
    } else {
      addLog("Frontend rebuilt successfully.", "system");
    }
  }

  addLog("Update complete. Restarting server...", "system");
  updateAvailable = false;
  updateCommitsBehind = 0;
  updateLatestMessage = "";
  updateInProgress = false;

  restartCount++;
  await stopServer();
  await startServer();
}

function startUpdateChecker(): void {
  // Initial check after a short delay (let the UI settle)
  setTimeout(() => checkForUpdates(), 5000);
  // Periodic checks
  updateCheckInterval = setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

function getStatusIndicator(): string {
  switch (state) {
    case "starting": return `${C.yellow}◐ Starting${C.R}`;
    case "running":  return `${C.green}● Running${C.R}`;
    case "stopping": return `${C.yellow}◑ Stopping${C.R}`;
    case "stopped":  return `${C.gray}○ Stopped${C.R}`;
    case "crashed":  return `${C.red}✖ Crashed${C.R}`;
  }
}

// Compact logo for the header bar
const MINI_LOGO = `${C.purple}L${C.blue}U${C.cyan}M${C.purple}I${C.blue}V${C.cyan}E${C.purple}R${C.blue}S${C.cyan}E${C.R}`;

function render(): void {
  const out: string[] = [];

  // ─── Header bar (row 1-2) ──────────────────────────────────────────
  const uptime = startedAt ? formatUptime(Date.now() - startedAt) : "—";
  const pidStr = serverPid ? String(serverPid) : "—";
  const modeStr = isDev ? `${C.yellow}DEV${C.R}` : `${C.green}PROD${C.R}`;

  const updateStr = updateInProgress
    ? `${C.yellow}⟳ Updating…${C.R}`
    : updateChecking
    ? `${C.gray}⟳${C.R}`
    : updateAvailable
    ? `${C.green}⬆ ${updateCommitsBehind} update${updateCommitsBehind > 1 ? "s" : ""}${C.R}`
    : "";

  const updateSegment = updateStr
    ? `${C.bgBar} ${updateStr} ${C.bgBar}${C.gray}│${C.R}`
    : "";

  out.push(`${C.bgBar}${ansi.bold} ${MINI_LOGO} ${C.bgBar}${C.gray}│${C.R}${C.bgBar} ${getStatusIndicator()} ${C.bgBar}${C.gray}│${C.R}${C.bgBar} ${C.gray}Port${C.R}${C.bgBar} ${C.white}${port}${C.R}${C.bgBar} ${C.gray}│${C.R}${C.bgBar} ${C.gray}PID${C.R}${C.bgBar} ${C.white}${pidStr}${C.R}${C.bgBar} ${C.gray}│${C.R}${C.bgBar} ${C.gray}Uptime${C.R}${C.bgBar} ${C.white}${uptime}${C.R}${C.bgBar} ${C.gray}│${C.R}${updateSegment}${C.bgBar} ${modeStr} ${C.bgBar}${" ".repeat(Math.max(0, cols - 75))}${C.R}`);

  // Separator
  out.push(`${C.darkGray}${"─".repeat(cols)}${C.R}`);

  // ─── Log area (rows 3 to rows-3) ──────────────────────────────────
  const logAreaHeight = rows - 4; // header(1) + separator(1) + separator(1) + action bar(1)
  const totalLogs = logLines.length;

  let startIdx: number;
  if (logScrollOffset === 0) {
    // Follow tail
    startIdx = Math.max(0, totalLogs - logAreaHeight);
  } else {
    startIdx = Math.max(0, totalLogs - logAreaHeight - logScrollOffset);
  }
  const endIdx = Math.min(startIdx + logAreaHeight, totalLogs);

  for (let i = startIdx; i < endIdx; i++) {
    // Truncate lines to terminal width (accounting for ANSI codes)
    out.push(logLines[i]);
  }

  // Pad remaining lines
  const rendered = endIdx - startIdx;
  for (let i = rendered; i < logAreaHeight; i++) {
    out.push("");
  }

  // Separator
  const scrollIndicator = logScrollOffset > 0
    ? `${C.yellow} ↑ ${logScrollOffset} lines above ${C.R}`
    : "";
  out.push(`${C.darkGray}${"─".repeat(cols)}${C.R}${scrollIndicator}`);

  // ─── Action bar ────────────────────────────────────────────────────
  const actionItems = [
    `${C.blue}R${C.gray}estart`,
    ...(updateAvailable ? [`${C.green}U${C.gray}pdate`] : []),
    `${C.blue}O${C.gray}pen Browser`,
    `${C.blue}C${C.gray}lear Log`,
    `${C.blue}↑↓${C.gray} Scroll`,
    `${C.blue}Q${C.gray}uit`,
  ];
  const actions = actionItems.join(`${C.R}  ${C.darkGray}│${C.R}  `);

  out.push(` ${actions}${C.R}`);

  // ─── Write to terminal ─────────────────────────────────────────────
  process.stdout.write(ansi.home);
  for (let i = 0; i < out.length; i++) {
    process.stdout.write(ansi.moveTo(i + 1, 1) + ansi.clearLine + out[i]);
  }
  // Flush any scrollback that may have accumulated from wrapped lines
  rawWrite(ansi.clearScrollback);
}

// ─── Keyboard input ─────────────────────────────────────────────────────────

function setupInput(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", async (data: Buffer) => {
    const key = data.toString();

    // Ctrl+C or q
    if (key === "\x03" || key === "q" || key === "Q") {
      await shutdown();
      return;
    }

    switch (key.toLowerCase()) {
      case "r":
        await restartServer();
        break;

      case "u":
        if (updateAvailable) {
          await applyUpdate();
        } else {
          addLog("Checking for updates...", "system");
          await checkForUpdates();
          if (!updateAvailable) addLog("Already up to date.", "system");
        }
        break;

      case "o": {
        const url = `http://localhost:${port}`;
        addLog(`Opening ${url}...`, "system");
        // Cross-platform browser open
        const cmd = process.platform === "darwin" ? "open"
          : process.platform === "win32" ? "start"
          : "xdg-open";
        Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
        break;
      }

      case "c":
        logLines.length = 0;
        logScrollOffset = 0;
        render();
        break;

      // Arrow up / scroll up
      case "\x1b[A":
        logScrollOffset = Math.min(logScrollOffset + 1, Math.max(0, logLines.length - (rows - 4)));
        render();
        break;

      // Arrow down / scroll down
      case "\x1b[B":
        logScrollOffset = Math.max(0, logScrollOffset - 1);
        render();
        break;

      // Page up
      case "\x1b[5~":
        logScrollOffset = Math.min(logScrollOffset + (rows - 4), Math.max(0, logLines.length - (rows - 4)));
        render();
        break;

      // Page down
      case "\x1b[6~":
        logScrollOffset = Math.max(0, logScrollOffset - (rows - 4));
        render();
        break;

      // Home — scroll to top
      case "\x1b[H":
        logScrollOffset = Math.max(0, logLines.length - (rows - 4));
        render();
        break;

      // End — follow tail
      case "\x1b[F":
        logScrollOffset = 0;
        render();
        break;
    }
  });
}

// ─── Uptime ticker ──────────────────────────────────────────────────────────

let tickInterval: ReturnType<typeof setInterval> | null = null;

function startTicker(): void {
  tickInterval = setInterval(() => {
    if (state === "running" || state === "starting") {
      render();
    }
  }, 1000);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  addLog("Shutting down...", "system");
  if (tickInterval) clearInterval(tickInterval);
  if (updateCheckInterval) clearInterval(updateCheckInterval);

  await stopServer();

  // Restore terminal
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  leaveAltScreen();

  console.log("\nLumiverse stopped. Goodbye!");
  process.exit(0);
}

// Handle external signals
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  enterAltScreen();

  addLog("Lumiverse Runner initialized.", "system");
  if (isDev) addLog("Running in development mode (watch enabled).", "system");

  setupInput();
  startTicker();
  startUpdateChecker();
  render();

  await startServer();
}

// Ensure terminal is always restored, even on unexpected errors
process.on("uncaughtException", (err) => {
  leaveAltScreen();
  console.error("Runner crashed (uncaught):", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  leaveAltScreen();
  console.error("Runner crashed (unhandled rejection):", reason);
  process.exit(1);
});

main().catch(async (err) => {
  leaveAltScreen();
  console.error("Runner failed:", err);
  process.exit(1);
});
