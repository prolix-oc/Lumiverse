import React, { useCallback, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync } from "fs";
import { join } from "path";
import { rmSync } from "fs";

import { HeaderBar } from "./components/HeaderBar.js";
import { LogView } from "./components/LogView.js";
import { ActionBar } from "./components/ActionBar.js";

import { useLogBuffer } from "./hooks/useLogBuffer.js";
import { useServerProcess } from "./hooks/useServerProcess.js";
import { useGitOps } from "./hooks/useGitOps.js";
import { useConfirmation } from "./hooks/useConfirmation.js";
import { useEnvConfig } from "./hooks/useEnvConfig.js";
import { useSelfWatcher } from "./hooks/useSelfWatcher.js";
import { openBrowser } from "./lib/browser.js";
import { PROJECT_ROOT } from "./lib/constants.js";
import { terminalEnv } from "./lib/terminal.js";

interface AppProps {
  isDev: boolean;
  leaveAltScreen: () => void;
}

export function App({ isDev, leaveAltScreen }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  // Use rows - 1 to avoid Ink's fullscreen detection (outputHeight >= stdout.rows),
  // which bypasses incrementalRendering and does a full clearTerminal + redraw on
  // every frame — causing visible flicker, especially over SSH. See Ink issue #450.
  //
  // Exception: terminals where incremental rendering's cursor-repositioning
  // sequences don't work reliably (tmux: header duplication, Windows Terminal
  // and conhost: eraseLines() cursor math breaks, Termux: limited VT support).
  // Use exact rows there so Ink falls back to full-screen clear-and-redraw mode.
  const termHeight = terminalEnv.useFullRedraw ? rows : rows - 1;

  // --- Hooks ---
  const logBuffer = useLogBuffer();
  const envConfig = useEnvConfig();
  const server = useServerProcess(isDev, logBuffer.addLog);
  const gitOps = useGitOps(logBuffer.addLog);

  const confirmation = useConfirmation(10_000, (type) => {
    const labels: Record<string, string> = {
      trust: "Remote access toggle",
      branch: "Branch switch",
      vector: "LanceDB reset",
    };
    logBuffer.addLog(
      `${labels[type] || type} cancelled (timed out).`,
      "system"
    );
  });

  // Self-watcher for runner source changes
  useSelfWatcher(logBuffer.addLog, server.stop, leaveAltScreen);

  // --- Actions ---
  const shutdown = useCallback(async () => {
    logBuffer.addLog("Shutting down...", "system");
    await server.stop();
    // Signal Ink to unmount — the entry point handles TTY restoration
    // via waitUntilExit() after this resolves.
    exit();
  }, [server, logBuffer, exit]);

  const handleUpdate = useCallback(async () => {
    if (gitOps.updateState.available) {
      await server.stop();
      await gitOps.applyUpdate(async () => {
        await server.start();
      });
    } else {
      logBuffer.addLog("Checking for updates...", "system");
      await gitOps.checkForUpdates();
      if (!gitOps.updateState.available) {
        logBuffer.addLog("Already up to date.", "system");
      }
    }
  }, [gitOps, server, logBuffer]);

  const handleBranchSwitch = useCallback(async () => {
    if (gitOps.branchSwitchInProgress) return;

    const target =
      gitOps.currentBranch === "main" ? "staging" : "main";

    const confirmed = confirmation.request("branch", target);
    if (confirmed) {
      await server.stop();
      await gitOps.switchBranch(target, async () => {
        await server.start();
      });
    } else {
      const label =
        target === "staging" ? "unstable (staging)" : "stable (main)";
      logBuffer.addLog("", "system");
      logBuffer.addLog(
        "╔══════════════════════════════════════════════════════════════╗",
        "system"
      );
      logBuffer.addLog(
        `║  ⚠  SWITCH BRANCH — ${label.padEnd(39)}║`,
        "system"
      );
      logBuffer.addLog(
        "║                                                            ║",
        "system"
      );
      logBuffer.addLog(
        `║  This will switch from '${gitOps.currentBranch}' to '${target}'.`.padEnd(
          63
        ) + "║",
        "system"
      );
      logBuffer.addLog(
        "║  The server will be stopped, branch switched, latest       ║",
        "system"
      );
      logBuffer.addLog(
        "║  changes pulled, dependencies installed if needed, the     ║",
        "system"
      );
      logBuffer.addLog(
        "║  frontend rebuilt, and the server restarted.               ║",
        "system"
      );
      logBuffer.addLog(
        "║                                                            ║",
        "system"
      );
      logBuffer.addLog(
        "║  Press B again within 10 seconds to confirm, or wait      ║",
        "system"
      );
      logBuffer.addLog(
        "║  to cancel.                                                ║",
        "system"
      );
      logBuffer.addLog(
        "╚══════════════════════════════════════════════════════════════╝",
        "system"
      );
      logBuffer.addLog("", "system");
    }
  }, [gitOps, server, confirmation, logBuffer]);

  const handleTrustToggle = useCallback(async () => {
    const enabling = !envConfig.trustAnyOrigin;

    if (enabling) {
      const confirmed = confirmation.request("trust");
      if (confirmed) {
        logBuffer.addLog(
          "Remote access ENABLED — TRUST_ANY_ORIGIN=true written to .env",
          "system"
        );
        logBuffer.addLog(
          "Any device can now connect. Restart in progress...",
          "system"
        );
        await envConfig.writeTrustAnyOrigin(true);
        await server.restart();
      } else {
        logBuffer.addLog("", "system");
        logBuffer.addLog(
          "╔══════════════════════════════════════════════════════════════╗",
          "system"
        );
        logBuffer.addLog(
          "║  ⚠  SECURITY WARNING — Remote / Mobile Access             ║",
          "system"
        );
        logBuffer.addLog(
          "║                                                            ║",
          "system"
        );
        logBuffer.addLog(
          "║  This disables CORS origin and host checking, allowing     ║",
          "system"
        );
        logBuffer.addLog(
          "║  ANY device on your network (or the internet, if port-     ║",
          "system"
        );
        logBuffer.addLog(
          "║  forwarded) to connect to this Lumiverse instance.         ║",
          "system"
        );
        logBuffer.addLog(
          "║                                                            ║",
          "system"
        );
        logBuffer.addLog(
          "║  Only enable this on trusted networks.                     ║",
          "system"
        );
        logBuffer.addLog(
          "║  Press T again within 10 seconds to confirm, or wait       ║",
          "system"
        );
        logBuffer.addLog(
          "║  to cancel.                                                ║",
          "system"
        );
        logBuffer.addLog(
          "╚══════════════════════════════════════════════════════════════╝",
          "system"
        );
        logBuffer.addLog("", "system");
      }
    } else {
      // Disabling — no confirmation needed
      logBuffer.addLog(
        "Remote access DISABLED — TRUST_ANY_ORIGIN reverted in .env",
        "system"
      );
      logBuffer.addLog(
        "Only localhost connections allowed. Restarting...",
        "system"
      );
      await envConfig.writeTrustAnyOrigin(false);
      await server.restart();
    }
  }, [envConfig, confirmation, server, logBuffer]);

  const handleVectorReset = useCallback(async () => {
    const confirmed = confirmation.request("vector");
    if (confirmed) {
      const lanceDir = join(PROJECT_ROOT, "data", "lancedb");

      logBuffer.addLog("Stopping server for LanceDB reset...", "system");
      await server.stop();

      try {
        if (existsSync(lanceDir)) {
          rmSync(lanceDir, { recursive: true, force: true });
          logBuffer.addLog(
            `Deleted LanceDB directory: ${lanceDir}`,
            "system"
          );
        } else {
          logBuffer.addLog(
            "No LanceDB directory found — nothing to delete.",
            "system"
          );
        }
      } catch (err: any) {
        logBuffer.addLog(
          `Failed to delete LanceDB directory: ${err.message}`,
          "stderr"
        );
      }

      logBuffer.addLog(
        "LanceDB reset complete. Restarting server...",
        "system"
      );
      logBuffer.addLog(
        "Note: SQLite vectorization flags will be reset on first access.",
        "system"
      );
      await server.start();
    } else {
      logBuffer.addLog("", "system");
      logBuffer.addLog(
        "╔══════════════════════════════════════════════════════════════╗",
        "system"
      );
      logBuffer.addLog(
        "║  ⚠  FORCE RESET — LanceDB Vector Store                    ║",
        "system"
      );
      logBuffer.addLog(
        "║                                                            ║",
        "system"
      );
      logBuffer.addLog(
        "║  This will STOP the server, completely delete the LanceDB  ║",
        "system"
      );
      logBuffer.addLog(
        "║  directory, and restart. All vector embeddings will be     ║",
        "system"
      );
      logBuffer.addLog(
        "║  lost and must be re-indexed.                              ║",
        "system"
      );
      logBuffer.addLog(
        "║                                                            ║",
        "system"
      );
      logBuffer.addLog(
        "║  Press V again within 10 seconds to confirm, or wait      ║",
        "system"
      );
      logBuffer.addLog(
        "║  to cancel.                                                ║",
        "system"
      );
      logBuffer.addLog(
        "╚══════════════════════════════════════════════════════════════╝",
        "system"
      );
      logBuffer.addLog("", "system");
    }
  }, [confirmation, server, logBuffer]);

  // --- Keyboard handler ---
  // All keybindings handled through Ink's useInput — no supplementary
  // stdin listener needed. Ink 6 natively parses pageUp/pageDown/home/end.
  const pageSize = Math.max(1, termHeight - 4);

  useInput(async (input, key) => {
    // Ctrl+C or q/Q → Quit
    if ((key.ctrl && input === "c") || input === "q" || input === "Q") {
      await shutdown();
      return;
    }

    // Letter keybindings
    switch (input.toLowerCase()) {
      case "r": // Restart server
        await server.restart();
        return;

      case "u": // Check/apply updates
        await handleUpdate();
        return;

      case "b": // Switch branch (with confirmation)
        await handleBranchSwitch();
        return;

      case "t": // Toggle remote/mobile access (with confirmation)
        await handleTrustToggle();
        return;

      case "v": // Force reset LanceDB vector store (with confirmation)
        await handleVectorReset();
        return;

      case "o": { // Open in browser
        const url = `http://localhost:${envConfig.port}`;
        logBuffer.addLog(`Opening ${url}...`, "system");
        openBrowser(url);
        return;
      }

      case "c": // Clear log
        logBuffer.clearLogs();
        return;
    }

    // Scroll controls
    if (key.upArrow) {
      logBuffer.scrollUp();
    } else if (key.downArrow) {
      logBuffer.scrollDown();
    } else if (key.pageUp) {
      logBuffer.pageUp(pageSize);
    } else if (key.pageDown) {
      logBuffer.pageDown(pageSize);
    } else if (key.home) {
      logBuffer.scrollToTop();
    } else if (key.end) {
      logBuffer.scrollToEnd();
    }
  });

  // --- Start server on mount ---
  useEffect(() => {
    logBuffer.addLog("Lumiverse Runner initialized.", "system");
    if (isDev) {
      logBuffer.addLog(
        "Running in development mode (watch enabled).",
        "system"
      );
    }
    server.start();
  }, []); // Intentionally empty — run once on mount

  // --- Render ---
  return (
    <Box flexDirection="column" width={cols} height={termHeight}>
      <HeaderBar
        serverState={server.state}
        port={envConfig.port}
        pid={server.pid}
        startedAt={server.startedAt}
        isDev={isDev}
        currentBranch={gitOps.currentBranch}
        trustAnyOrigin={envConfig.trustAnyOrigin}
        updateState={gitOps.updateState}
      />
      <LogView
        logs={logBuffer.logs}
        scrollOffset={logBuffer.scrollOffset}
      />
      <ActionBar
        serverState={server.state}
        updateState={gitOps.updateState}
        trustAnyOrigin={envConfig.trustAnyOrigin}
        branchSwitchInProgress={gitOps.branchSwitchInProgress}
        pending={confirmation.pending}
        scrollOffset={logBuffer.scrollOffset}
      />
    </Box>
  );
}
