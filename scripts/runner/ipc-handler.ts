import { join } from "path";
import { existsSync, rmSync } from "fs";
import { sendToServer, stopServer, startServer, restartServer } from "./server-manager.js";
import { checkForUpdates, applyUpdate, switchBranch } from "./git-ops.js";
import { readEnvConfig, writeTrustAnyOrigin } from "./env-config.js";
import { PROJECT_ROOT } from "./lib/constants.js";

/** Cached update state from the last check. */
let lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };

/** Whether a destructive operation is in progress. */
let operationInProgress: string | null = null;

let isDev = false;

export function setDevMode(dev: boolean): void {
  isDev = dev;
}

export function getLastUpdateState() {
  return lastUpdateState;
}

export function setLastUpdateState(state: typeof lastUpdateState): void {
  lastUpdateState = state;
}

function respond(id: string, success: boolean, data?: any, error?: string): void {
  sendToServer({ type: "response", id, payload: { success, data, error } });
}

function progress(id: string, operation: string, message: string): void {
  sendToServer({ type: "progress", id, payload: { operation, message } });
}

export async function handleIPCMessage(msg: any): Promise<void> {
  if (!msg?.type || !msg.id) return;

  const { type, id, payload } = msg;

  switch (type) {
    case "status": {
      respond(id, true, {
        updateAvailable: lastUpdateState.available,
        commitsBehind: lastUpdateState.commitsBehind,
        latestUpdateMessage: lastUpdateState.latestMessage,
      });
      break;
    }

    case "check-updates": {
      try {
        const state = await checkForUpdates();
        lastUpdateState = state;
        respond(id, true, state);
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Check failed");
      }
      break;
    }

    case "apply-update": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "update";
      try {
        progress(id, "update", "Starting update...");
        await applyUpdate(
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); }
        );
        lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };
        // Note: the server was restarted, so this response goes to the NEW process.
        // The old HTTP request will have been abandoned when the server stopped.
        // The new server will not have the pending request. This is expected.
      } catch (err) {
        // Server should be back up after error recovery in applyUpdate
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "switch-branch": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      const target = payload?.target;
      if (!target) {
        respond(id, false, undefined, "No target branch specified");
        break;
      }
      operationInProgress = "branch-switch";
      try {
        progress(id, "branch-switch", `Switching to ${target}...`);
        await switchBranch(
          target,
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); }
        );
        // Same note as apply-update: response goes to new server process
      } catch (err) {
        // Server should be back up after error recovery
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "toggle-remote": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      const enable = payload?.enable;
      if (typeof enable !== "boolean") {
        respond(id, false, undefined, "enable (boolean) is required");
        break;
      }
      operationInProgress = "remote-toggle";
      try {
        progress(id, "remote-toggle", enable ? "Enabling remote mode..." : "Disabling remote mode...");
        await writeTrustAnyOrigin(enable);
        // Restart for .env changes to take effect
        await restartServer(isDev);
        // Response goes to new process after restart
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Toggle failed");
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "restart": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "restart";
      try {
        respond(id, true, { message: "Restarting..." });
        // Small delay to let the response be sent before the server is killed
        await new Promise((r) => setTimeout(r, 100));
        await restartServer(isDev);
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "quit": {
      respond(id, true, { message: "Shutting down..." });
      await new Promise((r) => setTimeout(r, 100));
      await stopServer();
      process.exit(0);
    }

    case "clear-cache": {
      try {
        progress(id, "clear-cache", "Clearing package cache...");
        const proc = Bun.spawn(["bun", "pm", "cache", "rm"], {
          cwd: PROJECT_ROOT,
          stdout: "ignore",
          stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) {
          respond(id, false, undefined, stderr.trim() || "Cache clear failed");
        } else {
          respond(id, true, { message: "Package cache cleared" });
        }
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Cache clear failed");
      }
      break;
    }

    case "ensure-deps": {
      try {
        progress(id, "ensure-deps", "Installing backend dependencies...");
        const backendInstall = Bun.spawn(["bun", "install"], {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        await new Response(backendInstall.stdout).text();
        await backendInstall.exited;

        progress(id, "ensure-deps", "Installing frontend dependencies...");
        const frontendDir = join(PROJECT_ROOT, "frontend");
        const frontendInstall = Bun.spawn(["bun", "install"], {
          cwd: frontendDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await new Response(frontendInstall.stdout).text();
        await frontendInstall.exited;

        respond(id, true, { message: "Dependencies installed successfully" });
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Install failed");
      }
      break;
    }

    case "rebuild-frontend": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "rebuild";
      try {
        const frontendDir = join(PROJECT_ROOT, "frontend");
        const distDir = join(frontendDir, "dist");

        progress(id, "rebuild", "Rebuilding frontend...");
        await stopServer();

        if (existsSync(distDir)) {
          rmSync(distDir, { recursive: true, force: true });
        }

        const buildProc = Bun.spawn(["bun", "run", "build"], {
          cwd: frontendDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const buildOut = await new Response(buildProc.stdout).text();
        const buildErr = await new Response(buildProc.stderr).text();
        const buildCode = await buildProc.exited;

        if (buildCode !== 0) {
          console.error(`Frontend build failed: ${buildErr.trim() || buildOut.trim()}`);
        }

        startServer(isDev);
        // Response goes to new server process after restart
      } catch (err) {
        // Try to restart anyway
        try { startServer(isDev); } catch {}
      } finally {
        operationInProgress = null;
      }
      break;
    }

    default:
      // Unknown message type — ignore
      break;
  }
}
