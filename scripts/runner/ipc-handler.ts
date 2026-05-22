import { join } from "path";
import { sendToServer, stopServer, startServer, restartServer } from "./server-manager.js";
import {
  checkForUpdates,
  applyUpdate,
  switchBranch,
  ensureDependencies,
  rebuildFrontend,
} from "./git-ops.js";
import { writeTrustAnyOrigin } from "./env-config.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_BUN_CACHE_MS,
  TIMEOUT_BUN_INSTALL_MS,
} from "./lib/constants.js";
import { spawnAsync } from "./lib/spawn-async.js";

/** Cached update state from the last check. */
let lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };

/** Whether a destructive operation is in progress. */
let operationInProgress: string | null = null;

const RESPONSE_FLUSH_DELAY_MS = 150;

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

function waitForResponseFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RESPONSE_FLUSH_DELAY_MS));
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
      // Ack before killing the server. The fetch that initiated this request
      // will otherwise die along with the old server process — the frontend
      // relies on WS reconnect to drive the rest of the UX, so an early
      // success is what an "expected" restart looks like on the wire.
      respond(id, true, { message: "Applying update..." });
      try {
        await waitForResponseFlush();
        progress(id, "update", "Starting update...");
        await applyUpdate(
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); },
          (message) => progress(id, "update", message),
        );
        lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };
      } catch (err) {
        console.error("[runner] Update failed:", err);
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
      // Validate the target before killing the server. The inner switchBranch()
      // has the same guard, but throwing from inside would leave the IPC
      // request hanging the full 5-minute timeout with no user feedback.
      if (!AVAILABLE_BRANCHES.includes(target)) {
        respond(id, false, undefined, `Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
        break;
      }
      operationInProgress = "branch-switch";
      respond(id, true, { message: `Switching to ${target}...` });
      try {
        await waitForResponseFlush();
        progress(id, "branch-switch", `Switching to ${target}...`);
        await switchBranch(
          target,
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); },
          (message) => progress(id, "branch-switch", message),
        );
      } catch (err) {
        console.error("[runner] Branch switch failed:", err);
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
      // Ack before .env write + restart so the caller isn't left waiting on
      // a dead socket; the frontend will pick up the WS disconnect.
      respond(id, true, { enabled: enable, message: enable ? "Enabling remote mode..." : "Disabling remote mode..." });
      try {
        await waitForResponseFlush();
        progress(id, "remote-toggle", enable ? "Enabling remote mode..." : "Disabling remote mode...");
        await writeTrustAnyOrigin(enable);
        // Restart for .env changes to take effect
        await restartServer(isDev);
      } catch (err) {
        // Restart paths handle their own recovery; the ack already went out.
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
        await waitForResponseFlush();
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
        const result = await spawnAsync(["bun", "pm", "cache", "rm"], {
          cwd: PROJECT_ROOT,
          timeoutMs: TIMEOUT_BUN_CACHE_MS,
          ignoreStdout: true,
        });
        if (result.exitCode !== 0) {
          const reason = result.timedOut
            ? `timed out after ${TIMEOUT_BUN_CACHE_MS / 1000}s`
            : result.stderr.trim() || "Cache clear failed";
          respond(id, false, undefined, reason);
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
        const backend = await spawnAsync(["bun", "install"], {
          cwd: PROJECT_ROOT,
          timeoutMs: TIMEOUT_BUN_INSTALL_MS,
        });
        if (backend.exitCode !== 0) {
          const reason = backend.timedOut
            ? `backend install timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
            : backend.stderr.trim() || "backend install failed";
          respond(id, false, undefined, reason);
          break;
        }

        progress(id, "ensure-deps", "Installing frontend dependencies...");
        const frontendDir = join(PROJECT_ROOT, "frontend");
        const frontend = await spawnAsync(["bun", "install"], {
          cwd: frontendDir,
          timeoutMs: TIMEOUT_BUN_INSTALL_MS,
        });
        if (frontend.exitCode !== 0) {
          const reason = frontend.timedOut
            ? `frontend install timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
            : frontend.stderr.trim() || "frontend install failed";
          respond(id, false, undefined, reason);
          break;
        }

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
      // Ack now so the caller's fetch resolves before we kill the server.
      // Without this, the HTTP request dies along with the old server and
      // the frontend only finds out via the WS reconnect path.
      respond(id, true, { message: "Rebuilding frontend..." });
      try {
        await waitForResponseFlush();
        const frontendDir = join(PROJECT_ROOT, "frontend");

        progress(id, "rebuild", "Stopping server for dependency checks and frontend rebuild...");
        await stopServer();

        progress(id, "rebuild", "Installing backend and frontend dependencies...");
        await ensureDependencies(frontendDir);

        progress(id, "rebuild", "Waiting for Vite build to finish...");
        await rebuildFrontend(frontendDir);

        startServer(isDev);
      } catch (err) {
        console.error("[runner] Frontend rebuild failed:", err);
        console.error("[runner] Server remains stopped because the rebuild did not complete successfully.");
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
