import { existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT, ENTRY, STOP_SIGTERM_GRACE_MS } from "./lib/constants.js";
import {
  launchServerProcess,
  type ManagedServerProcess,
  type ServerControl,
  type ServerLaunchTransport,
} from "./server-process-launcher.js";
import type { ServerOutputStream } from "./server-process-output.js";
import { configuredBunExecutable, ensureBunRuntime } from "../../src/runtime/bun-runtime.js";
import { bunCmdForEnv } from "../../src/utils/bun-cmd.js";

export type ServerState = "starting" | "running" | "stopping" | "stopped" | "crashed";
export interface ServerLogSession {
  id: string;
  startedAt: string;
}
export const DESKTOP_LOG_TOKEN_ENV = "LUMIVERSE_DESKTOP_LOG_TOKEN";
const OUTPUT_DRAIN_GRACE_MS = 1_000;

type IPCCallback = (message: any) => void;

interface ServerInstance {
  proc: ManagedServerProcess | null;
  control: ServerControl | null;
  finalizeOutput: (() => Promise<void>) | null;
  state: ServerState;
  startedAt: number;
  restartCount: number;
}

let instance: ServerInstance | null = null;
let ipcCallback: IPCCallback | null = null;
let onStateChange: ((state: ServerState) => void) | null = null;
let onLogSessionStart: ((session: ServerLogSession) => void) | null = null;

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/** Register callback for IPC messages from server child process. */
export function setIPCHandler(cb: IPCCallback): void {
  ipcCallback = cb;
}

/** Register callback for server state changes. */
export function setStateChangeHandler(cb: (state: ServerState) => void): void {
  onStateChange = cb;
}

/** Register a hook that opens a fresh desktop log before each backend spawn. */
export function setLogSessionStartHandler(
  cb: ((session: ServerLogSession) => void) | null,
): void {
  onLogSessionStart = cb;
}

function setState(state: ServerState): void {
  if (instance) instance.state = state;
  onStateChange?.(state);
}

function handleServerMessage(message: any): void {
  if (message?.type === "ready") setState("running");
  ipcCallback?.(message);
}

/**
 * Bun 1.4.x supports IPC on Windows, but its child-exit delivery and
 * disconnect lifecycle still have Windows-specific gaps. Keep the authenticated
 * socket transport until upstream's Windows lifecycle tests reach parity and
 * this repository's Windows runner test verifies that behavior end to end.
 */
export function serverLaunchTransport(platform: string = process.platform): ServerLaunchTransport {
  return platform === "win32" ? "socket" : "ipc";
}

/**
 * Build the backend launch command without dropping the compatibility wrapper
 * that started the runner. Desktop/ordinary hosts still use the validated Bun
 * executable directly; native Termux reuses start.sh's direct/grun/proot chain.
 */
export function backendBunCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.LUMIVERSE_BUN_METHOD && env.LUMIVERSE_BUN_PATH) {
    return bunCmdForEnv(env, ...args);
  }
  return [configuredBunExecutable(env), ...args];
}

/**
 * Where server stdout/stderr bytes go. Defaults to the runner's own
 * stdio (terminal mode); the headless bridge installs a sink that wraps
 * output pipes in protocol frames so raw server bytes never reach stdout.
 * Socket-controlled children declare inherited output and bypass this sink.
 */
export type OutputSink = (chunk: Uint8Array, stream: ServerOutputStream) => void;

let outputSink: OutputSink | null = null;

export function setOutputSink(sink: OutputSink | null): void {
  outputSink = sink;
}

function writeServerOutput(chunk: Uint8Array, stream: ServerOutputStream): void {
  if (outputSink) {
    outputSink(chunk, stream);
  } else {
    (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
  }
}

function createOutputFinalizer(
  outputDone: Promise<void>,
  closeOutput: () => void,
): () => Promise<void> {
  let finalizing: Promise<void> | null = null;
  return () => {
    if (finalizing) return finalizing;
    finalizing = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // A descendant may still own the pipe after the backend exits. Stop
        // accepting that stale output before the next log session begins.
        closeOutput();
        finish();
      }, OUTPUT_DRAIN_GRACE_MS);
      outputDone.then(finish, finish);
    });
    return finalizing;
  };
}

// smol (low-memory GC mode) defaults on to preserve historical behavior and
// keep low-RAM / Termux installs healthy. Operators opt out with
// LUMIVERSE_SMOL=false (or 0/off/no) in .env — a choice that survives updates,
// unlike an edit to the committed bunfig.toml.
function smolEnabled(): boolean {
  const v = (process.env.LUMIVERSE_SMOL ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

/**
 * The shell launchers export FRONTEND_DIR before starting the runner, but the
 * desktop tray starts it directly. Fall back to the checkout's existing
 * production bundle so opening the local server has a document to serve.
 */
function frontendDir(): string | undefined {
  const configured = process.env.FRONTEND_DIR?.trim();
  if (configured) return configured;

  const bundled = join(PROJECT_ROOT, "frontend", "dist");
  return existsSync(join(bundled, "index.html")) ? bundled : undefined;
}

export async function startServer(isDev: boolean): Promise<void> {
  if (instance?.proc) return;

  // Re-read package.json on every start. An operator update or external pull
  // may have raised the runtime floor since this long-lived runner launched.
  await ensureBunRuntime(PROJECT_ROOT);

  const smol = smolEnabled() ? ["--smol"] : [];
  // Keep the validated executable for desktop/ordinary hosts, but preserve
  // start.sh's compatibility wrapper on native Termux.
  const args = backendBunCommand(
    isDev ? [...smol, "--watch", ENTRY] : [...smol, ENTRY],
  );

  const restartCount = instance ? instance.restartCount : 0;
  const frontend = isDev ? "" : frontendDir() ?? "";
  const inheritedEnv = { ...process.env };
  // The native host uses this secret to authenticate log-session markers on
  // channels that may also contain raw backend output. Never pass it on to the
  // backend child itself.
  delete inheritedEnv[DESKTOP_LOG_TOKEN_ENV];
  const childEnv = {
    ...inheritedEnv,
    FORCE_COLOR: "1",
    LUMIVERSE_RUNNER_IPC: "1",
    FRONTEND_DIR: frontend,
    ...("BUN_RUNTIME_TRANSPILER_CACHE_PATH" in process.env
      ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }
      : { BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(PROJECT_ROOT, "data", ".bun-transpiler-cache") }),
  };

  const launchTransport = serverLaunchTransport();
  let proc: ManagedServerProcess;
  let control: ServerControl;
  let finalizeOutput: () => Promise<void>;

  // Emit this before Bun.spawn. The headless bridge mirrors the marker onto
  // both output channels, preserving ordering when a launch transport inherits
  // the runner's stderr instead of using owned output pipes.
  onLogSessionStart?.({
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
  });

  try {
    const launched = launchServerProcess({
      transport: launchTransport,
      cmd: args,
      cwd: PROJECT_ROOT,
      env: childEnv,
      onMessage: handleServerMessage,
      onControlError(message) {
        console.error(`[${ts()}] [runner] Backend control channel failed: ${message}`);
      },
      onControlDisconnect() {},
      writeOutput: writeServerOutput,
    });
    proc = launched.proc;
    control = launched.control;
    finalizeOutput = createOutputFinalizer(launched.outputDone, launched.closeOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onStateChange?.("crashed");
    throw new Error(`Failed to launch Lumiverse backend: ${message}`);
  }

  instance = {
    proc,
    control,
    finalizeOutput,
    state: "starting",
    startedAt: Date.now(),
    restartCount,
  };

  onStateChange?.("starting");

  // Handle process exit
  proc.exited.then(async (code) => {
    control.close();
    // A process can exit while its pipe readers still have buffered bytes.
    // Finish those reads before declaring the lifecycle complete or allowing
    // a restart to select its next timestamped log.
    await finalizeOutput();
    if (!instance || instance.proc !== proc) return;

    if (instance.state === "stopping") {
      setState("stopped");
    } else if (code !== 0) {
      console.error(`[${ts()}] [runner] Server exited with code ${code}`);
      setState("crashed");
    } else {
      setState("stopped");
    }

    instance = { ...instance, proc: null, control: null, finalizeOutput: null };
  });

  // Readiness comes from the backend after Bun.serve has bound its socket.
  // Importing modules, tokenizers, and extensions can take well over three
  // seconds; elapsed time alone must not open the desktop browser early.
}

export async function stopServer(): Promise<void> {
  if (!instance?.proc) return;

  setState("stopping");
  console.log(`[${ts()}] [runner] Stopping server...`);

  const proc = instance.proc;
  const finalizeOutput = instance.finalizeOutput;

  // Graceful: SIGTERM triggers src/index.ts gracefulShutdown() (MCP,
  // extensions, DB close).
  try { proc.kill("SIGTERM"); } catch { /* already dead */ }

  // Escalation: if the shutdown hooks hang (wedged extension worker,
  // blocked MCP disconnect, stuck WAL close), SIGKILL after the grace
  // window. Without this the runner would block forever on proc.exited
  // and the whole branch-switch / update flow would stall with no
  // recovery path.
  const forceKill = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
      console.log(
        `[${ts()}] [runner] Server did not exit within ${STOP_SIGTERM_GRACE_MS}ms of SIGTERM; sent SIGKILL.`
      );
    } catch { /* already dead */ }
  }, STOP_SIGTERM_GRACE_MS);

  await proc.exited;
  await finalizeOutput?.();
  clearTimeout(forceKill);
}

export async function restartServer(isDev: boolean): Promise<void> {
  const count = instance ? instance.restartCount + 1 : 1;
  console.log(`[${ts()}] [runner] Restarting server (restart #${count})...`);
  await stopServer();
  await startServer(isDev);
  if (instance) instance.restartCount = count;
}

/** Send an IPC message to the server child process. */
export function sendToServer(message: any): boolean {
  if (!instance?.proc || !instance.control) return false;
  return instance.control.send(message);
}

export function getServerState(): ServerState {
  return instance?.state ?? "stopped";
}

export function getServerPid(): number | null {
  return instance?.proc?.pid ?? null;
}

export function getStartedAt(): number | null {
  return instance?.startedAt ?? null;
}

/** Synchronously kill the server process. For signal handlers. */
export function killServerSync(): void {
  if (instance?.proc) {
    try {
      instance.proc.kill();
    } catch { /* already dead */ }
  }
}
