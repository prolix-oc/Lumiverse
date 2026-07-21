import { join, resolve } from "path";
import {
  sendToServer,
  stopServer,
  startServer,
  restartServer,
  getServerState,
  getServerPid,
  getStartedAt,
} from "./server-manager.js";
import {
  checkForUpdates,
  applyUpdate,
  switchBranch,
  ensureDependencies,
  ensureFrontendDependencies,
  rebuildFrontend,
  runWithServerStopped,
} from "./git-ops.js";
import { readEnvConfig, writeTrustAnyOrigin } from "./env-config.js";
import { getCurrentBranch } from "./lib/git.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_BUN_CACHE_MS,
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

/**
 * Response sink override, keyed by request id. Requests that arrive over
 * child IPC reply through the server (sendToServer). Requests that arrive
 * from another transport — e.g. the headless stdio bridge used by the
 * desktop tray app — register a sink here so responses and progress
 * events return to their origin instead of the server child (which may
 * not even be running).
 */
type ResponseSink = (message: any) => void;
const externalSinks = new Map<string, ResponseSink>();
// Sinks stay registered after the response because long operations keep
// emitting progress events under the same id. Cap the map so ids from a
// long-lived supervisor session can't accumulate without bound.
const MAX_EXTERNAL_SINKS = 100;

function registerExternalSink(id: string, sink: ResponseSink): void {
  if (externalSinks.size >= MAX_EXTERNAL_SINKS) {
    const oldest = externalSinks.keys().next().value;
    if (oldest !== undefined) externalSinks.delete(oldest);
  }
  externalSinks.set(id, sink);
}

function deliver(id: string, message: any): void {
  const sink = externalSinks.get(id);
  if (sink) {
    sink(message);
    return;
  }
  sendToServer(message);
}

function respond(id: string, success: boolean, data?: any, error?: string): void {
  deliver(id, { type: "response", id, payload: { success, data, error } });
}

function progress(id: string, operation: string, message: string): void {
  deliver(id, { type: "progress", id, payload: { operation, message } });
}

function readRunnerVersion(): string {
  try {
    const pkg = require(resolve(import.meta.dir, "../../package.json"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function waitForResponseFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RESPONSE_FLUSH_DELAY_MS));
}

export async function handleIPCMessage(msg: any, sink?: ResponseSink): Promise<void> {
  if (!msg?.type || !msg.id) return;

  const { type, id, payload } = msg;
  if (sink) registerExternalSink(id, sink);

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
        const frontendDir = join(PROJECT_ROOT, "frontend");
        progress(id, "ensure-deps", "Installing backend and frontend dependencies...");
        await ensureDependencies(frontendDir);
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

        progress(id, "rebuild", "Stopping server for frontend rebuild...");
        await runWithServerStopped(
          "Frontend rebuild",
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); },
          async () => {
            progress(id, "rebuild", "Installing frontend dependencies...");
            await ensureFrontendDependencies(frontendDir);

            progress(id, "rebuild", "Waiting for Vite build to finish...");
            await rebuildFrontend(frontendDir);
          },
        );
      } catch (err) {
        console.error("[runner] Frontend rebuild failed:", err);
        console.error("[runner] Server restarted with the previous validated frontend bundle.");
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "start-server": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      const state = getServerState();
      if (state === "running" || state === "starting") {
        respond(id, true, { state });
        break;
      }
      startServer(isDev);
      respond(id, true, { state: getServerState() });
      break;
    }

    case "stop-server": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      await stopServer();
      respond(id, true, { state: getServerState() });
      break;
    }

    case "full-status": {
      const envConfig = readEnvConfig();
      respond(id, true, {
        state: getServerState(),
        pid: getServerPid(),
        startedAt: getStartedAt(),
        port: envConfig.port,
        branch: getCurrentBranch() || "unknown",
        version: readRunnerVersion(),
        updateAvailable: lastUpdateState.available,
        commitsBehind: lastUpdateState.commitsBehind,
        latestUpdateMessage: lastUpdateState.latestMessage,
      });
      break;
    }

    default:
      // Unknown message type — ignore
      break;
  }
}
