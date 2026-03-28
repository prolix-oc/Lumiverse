#!/usr/bin/env bun
/**
 * Lumiverse Visual Runner (Ink TUI)
 *
 * A terminal dashboard that spawns the backend as a child process and
 * provides real-time log viewing, status monitoring, and process control.
 *
 * Usage:
 *   bun run runner
 *   bun run scripts/runner.tsx [-- --dev]
 *
 * Keyboard:
 *   R - Restart server
 *   U - Update from GitHub (when available)
 *   B - Switch branch (main ↔ staging, confirmation required)
 *   T - Toggle remote/mobile access (TRUST_ANY_ORIGIN)
 *   V - Force reset LanceDB vector store (confirmation required)
 *   O - Open in browser
 *   C - Clear log
 *   Q / Ctrl+C - Quit
 */

import React from "react";
import { render } from "ink";
import { App } from "./runner/App.js";
import { killServerProcess } from "./runner/hooks/useServerProcess.js";
import { terminalEnv } from "./runner/lib/terminal.js";

// ─── Parse args ──────────────────────────────────────────────────────────────

const isDev = process.argv.includes("--dev");

// ─── Alternate screen management ─────────────────────────────────────────────

function enterAltScreen(): void {
  // Clear main buffer scrollback — prevents macOS Terminal.app from
  // letting the user scroll up past the TUI into old shell history.
  // Skip on terminals that don't support ED3 (conhost, Termux, tmux).
  if (terminalEnv.supportsClearScrollback) {
    process.stdout.write("\x1b[3J");
  }
  // Switch to alternate screen buffer
  process.stdout.write("\x1b[?1049h");
  // Clear and park cursor
  process.stdout.write("\x1b[2J\x1b[H");
  // Hide cursor for the TUI (always use ANSI — .NET Console API is
  // unreliable in the alternate buffer on some Windows builds)
  process.stdout.write("\x1b[?25l");
}

let _terminalRestored = false;

function restoreTerminal(): void {
  if (_terminalRestored) return;
  _terminalRestored = true;

  // Single write with all VT restoration sequences to minimize fragmentation
  // over SSH (each write() can become a separate SSH data message).
  //   \x1b[r        — Reset scroll region
  //   \x1b[?25h     — Show cursor
  //   \x1b[?1049l   — Leave alternate screen buffer (restores main buffer)
  process.stdout.write("\x1b[r\x1b[?25h\x1b[?1049l");

  // Ensure raw mode is off so the shell gets normal input back
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // may already be restored
    }
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

enterAltScreen();

const app = render(
  React.createElement(App, { isDev, leaveAltScreen: restoreTerminal }),
  {
    patchConsole: false,
    exitOnCtrlC: false,
    // Line-by-line diffing: only rewrite lines whose content changed.
    // Default (false) erases the entire output area and redraws from scratch,
    // which causes visible flicker over SSH and on Windows terminals.
    incrementalRendering: true,
    // 15 FPS is more than enough for a server dashboard (log batches arrive
    // at ~10/s, uptime ticks at 1/s). Halves render pressure vs the default 30.
    maxFps: 15,
  }
);

// Wait for Ink to fully unmount (triggered by App calling exit()),
// then restore the terminal and exit cleanly.
app.waitUntilExit().then(() => {
  restoreTerminal();
  // Brief delay before exit so the VT restore sequences are transmitted
  // through the SSH channel / pty before the process (and connection) closes.
  setTimeout(() => {
    console.log("\nLumiverse stopped. Goodbye!");
    process.exit(0);
  }, 50);
});

// ─── Signal handlers ─────────────────────────────────────────────────────────
// These fire when the process receives external signals (e.g. terminal close).
// Kill the server synchronously, unmount Ink, restore TTY, then exit.

function handleSignal(): void {
  killServerProcess();
  app.unmount();
  restoreTerminal();
  // Brief delay for VT sequences to flush through SSH/pty before exit
  setTimeout(() => process.exit(0), 50);
}

process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);

// Ensure terminal is always restored on unexpected errors
process.on("uncaughtException", (err) => {
  killServerProcess();
  restoreTerminal();
  console.error("Runner crashed (uncaught):", err);
  setTimeout(() => process.exit(1), 50);
});

process.on("unhandledRejection", (reason) => {
  killServerProcess();
  restoreTerminal();
  console.error("Runner crashed (unhandled rejection):", reason);
  setTimeout(() => process.exit(1), 50);
});
