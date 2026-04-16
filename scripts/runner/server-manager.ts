import { PROJECT_ROOT, ENTRY, STOP_FORCE_KILL_MS } from "./lib/constants.js";

export type ServerState = "starting" | "running" | "stopping" | "stopped" | "crashed";

type IPCCallback = (message: any) => void;

interface ServerInstance {
  proc: ReturnType<typeof Bun.spawn>;
  state: ServerState;
  startedAt: number;
  restartCount: number;
}

let instance: ServerInstance | null = null;
let ipcCallback: IPCCallback | null = null;
let onStateChange: ((state: ServerState) => void) | null = null;

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

function setState(state: ServerState): void {
  if (instance) instance.state = state;
  onStateChange?.(state);
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(value);
    }
  } catch {
    // Stream closed
  }
}

export function startServer(isDev: boolean): void {
  if (instance?.proc) return;

  const args = isDev
    ? ["bun", "run", "--watch", ENTRY]
    : ["bun", "run", ENTRY];

  const restartCount = instance ? instance.restartCount : 0;

  const proc = Bun.spawn(args, {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      LUMIVERSE_RUNNER_IPC: "1",
    },
    ipc(message) {
      // Handle IPC messages from the server child
      if (message?.type === "ready") {
        setState("running");
      }
      ipcCallback?.(message);
    },
  });

  instance = {
    proc,
    state: "starting",
    startedAt: Date.now(),
    restartCount,
  };

  onStateChange?.("starting");

  // Pipe stdout/stderr to terminal
  if (proc.stdout) readStream(proc.stdout, process.stdout);
  if (proc.stderr) readStream(proc.stderr, process.stderr);

  // Handle process exit
  proc.exited.then((code) => {
    if (!instance || instance.proc !== proc) return;

    if (instance.state === "stopping") {
      setState("stopped");
    } else if (code !== 0) {
      console.error(`[${ts()}] [runner] Server exited with code ${code}`);
      setState("crashed");
    } else {
      setState("stopped");
    }

    instance = { ...instance!, proc: null as any, state: instance!.state };
  });

  // Fallback: assume running after 3s if "ready" IPC not received
  setTimeout(() => {
    if (instance?.state === "starting") {
      setState("running");
    }
  }, 3000);
}

export async function stopServer(): Promise<void> {
  if (!instance?.proc) return;

  setState("stopping");
  console.log(`[${ts()}] [runner] Stopping server...`);

  const proc = instance.proc;
  proc.kill();

  // Force kill after timeout
  const forceKill = setTimeout(() => {
    try {
      proc.kill();
      console.log(`[${ts()}] [runner] Force killed server (timeout).`);
    } catch { /* already dead */ }
  }, STOP_FORCE_KILL_MS);

  await proc.exited;
  clearTimeout(forceKill);
}

export async function restartServer(isDev: boolean): Promise<void> {
  const count = instance ? instance.restartCount + 1 : 1;
  console.log(`[${ts()}] [runner] Restarting server (restart #${count})...`);
  await stopServer();
  startServer(isDev);
  if (instance) instance.restartCount = count;
}

/** Send an IPC message to the server child process. */
export function sendToServer(message: any): boolean {
  if (!instance?.proc) return false;
  try {
    instance.proc.send(message);
    return true;
  } catch {
    return false;
  }
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
