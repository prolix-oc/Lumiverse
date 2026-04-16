import { useState, useCallback, useRef, useEffect } from "react";
import { PROJECT_ROOT, ENTRY, STARTUP_DETECT_TIMEOUT_MS, STOP_FORCE_KILL_MS } from "../lib/constants.js";
import type { LogSource } from "./useLogBuffer.js";

export type ServerState = "starting" | "running" | "stopping" | "stopped" | "crashed";

export interface ServerProcessApi {
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  restartCount: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

/**
 * Module-level ref to the active server process.
 * Signal handlers use this to kill the server synchronously
 * without needing access to React state.
 */
let _activeProc: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Synchronously kill the server process if running.
 * Called from signal handlers in runner.tsx where we can't await.
 */
export function killServerProcess(): void {
  if (_activeProc) {
    try {
      _activeProc.kill();
    } catch {
      // Process may already be dead
    }
    _activeProc = null;
  }
}

export function useServerProcess(
  isDev: boolean,
  addLog: (text: string, source?: LogSource) => void
): ServerProcessApi {
  const [state, setState] = useState<ServerState>("stopped");
  const [pid, setPid] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [restartCount, setRestartCount] = useState(0);

  const procRef = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  const stateRef = useRef<ServerState>("stopped");

  // Keep stateRef in sync
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Kill server on unmount (component teardown)
  useEffect(() => {
    return () => {
      const proc = procRef.current;
      if (proc) {
        try {
          proc.kill();
        } catch {
          // already dead
        }
        procRef.current = null;
        _activeProc = null;
      }
    };
  }, []);

  const streamReader = useCallback(
    async (
      stream: ReadableStream<Uint8Array>,
      source: "stdout" | "stderr"
    ) => {
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
            if (
              line.includes("starting on port") &&
              stateRef.current === "starting"
            ) {
              setState("running");
            }
            addLog(line, source);
          }
        }
        // Flush remaining
        if (buffer.trim()) addLog(buffer, source);
      } catch {
        // Stream closed
      }
    },
    [addLog]
  );

  const start = useCallback(async () => {
    if (procRef.current) return;

    setState("starting");
    setStartedAt(Date.now());
    addLog("Starting Lumiverse Backend...", "system");

    const args = isDev
      ? ["bun", "run", "--watch", ENTRY]
      : ["bun", "run", ENTRY];

    const proc = Bun.spawn(args, {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FORCE_COLOR: "1",
      },
    });

    procRef.current = proc;
    _activeProc = proc;
    setPid(proc.pid);

    if (proc.stdout) streamReader(proc.stdout, "stdout");
    if (proc.stderr) streamReader(proc.stderr, "stderr");

    // Wait for process exit
    proc.exited.then((code) => {
      procRef.current = null;
      _activeProc = null;
      setPid(null);

      if (stateRef.current === "stopping") {
        setState("stopped");
        addLog("Server stopped.", "system");
      } else if (code !== 0) {
        setState("crashed");
        addLog(`Server exited with code ${code}`, "system");
      } else {
        setState("stopped");
        addLog("Server exited.", "system");
      }
    });

    // Assume running after brief delay if not already detected
    setTimeout(() => {
      if (stateRef.current === "starting") {
        setState("running");
      }
    }, STARTUP_DETECT_TIMEOUT_MS);
  }, [isDev, addLog, streamReader]);

  const stop = useCallback(async () => {
    const proc = procRef.current;
    if (!proc) return;

    setState("stopping");
    addLog("Stopping server...", "system");

    proc.kill();

    // Force kill after timeout
    const timeout = setTimeout(() => {
      if (procRef.current) {
        addLog("Force killing server (timeout)...", "system");
        procRef.current.kill();
      }
    }, STOP_FORCE_KILL_MS);

    await proc.exited;
    clearTimeout(timeout);
    procRef.current = null;
    _activeProc = null;
  }, [addLog]);

  const restart = useCallback(async () => {
    setRestartCount((c) => c + 1);
    addLog(`Restarting server (restart #${restartCount + 1})...`, "system");
    await stop();
    await start();
  }, [stop, start, restartCount, addLog]);

  return { state, pid, startedAt, restartCount, start, stop, restart };
}
