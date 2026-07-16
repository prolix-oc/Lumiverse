import { initializeSandbox } from "./worker-runtime-sandbox";

const nativeProcessExit = process.exit.bind(process);

type BackendProcessInit = {
  processId: string;
  entry: string;
  kind: string;
  entryPath: string;
  /** Host-derived capability; extension input never controls this flag. */
  allowDynamicCode?: boolean;
  key?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
};

type HostToBackendProcess =
  | { type: "init"; process: BackendProcessInit }
  | { type: "stop"; reason?: string }
  | { type: "message"; payload: unknown };

type BackendProcessToHost =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "message"; payload: unknown }
  | { type: "complete" }
  | { type: "fail"; error: string }
  | { type: "stopped" };

type StopHandler = (detail: { reason?: string }) => void;
type MessageHandler = (payload: unknown) => void;
type BackendProcessHandler = (
  process: BackendProcessContext
) => void | (() => void) | Promise<void | (() => void)>;

type BackendProcessContext = {
  processId: string;
  entry: string;
  kind: string;
  key?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
  ready(): void;
  heartbeat(): void;
  send(payload: unknown): void;
  onMessage(handler: MessageHandler): () => void;
  complete(result?: unknown): void;
  fail(error: string): void;
  onStop(handler: StopHandler): () => void;
};

type ActiveBackendProcess = {
  processId: string;
  cleanup?: (() => void) | void;
  terminal: boolean;
  readySent: boolean;
  messageHandlers: Set<MessageHandler>;
  stopHandlers: Set<StopHandler>;
};

let activeProcess: ActiveBackendProcess | null = null;
let runtimeTerminal = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProcessInit(message: unknown): BackendProcessInit {
  if (
    !isRecord(message) ||
    !Object.hasOwn(message, "process") ||
    !isRecord(message.process)
  ) {
    throw new Error("Invalid backend process init payload");
  }

  const processInit = message.process;
  if (
    !Object.hasOwn(processInit, "processId") ||
    !Object.hasOwn(processInit, "entry") ||
    !Object.hasOwn(processInit, "kind") ||
    !Object.hasOwn(processInit, "entryPath") ||
    typeof processInit.processId !== "string" ||
    typeof processInit.entry !== "string" ||
    typeof processInit.kind !== "string" ||
    typeof processInit.entryPath !== "string" ||
    (processInit.allowDynamicCode !== undefined && typeof processInit.allowDynamicCode !== "boolean") ||
    (processInit.key !== undefined && typeof processInit.key !== "string") ||
    (processInit.metadata !== undefined && !isRecord(processInit.metadata)) ||
    (processInit.userId !== undefined && typeof processInit.userId !== "string")
  ) {
    throw new Error("Invalid backend process init payload");
  }

  return processInit as BackendProcessInit;
}

function post(message: BackendProcessToHost): void {
  if (typeof process.send === "function") {
    process.send(message);
    return;
  }
  self.postMessage(message);
}

function shutdown(kind: "complete" | "fail" | "stopped", error?: string): void {
  const processState = activeProcess;
  if (runtimeTerminal || processState?.terminal) return;
  runtimeTerminal = true;

  if (processState) {
    processState.terminal = true;

    try {
      processState.cleanup?.();
    } catch (err) {
      console.error("[Spindle backend process] Cleanup failed:", err);
    }

    processState.messageHandlers.clear();
    processState.stopHandlers.clear();
    activeProcess = null;
  }

  try {
    if (kind === "fail") {
      post({ type: "fail", error: error?.trim() || "Backend process failed" });
    } else {
      post({ type: kind });
    }
  } catch (err) {
    console.error("[Spindle backend process] Terminal post failed:", err);
  } finally {
    nativeProcessExit(kind === "fail" ? 1 : 0);
  }
}

async function handleInit(msg: unknown): Promise<void> {
  let processState: ActiveBackendProcess | null = null;

  try {
    if (runtimeTerminal) return;
    const processInit = readProcessInit(msg);
    processState = {
      processId: processInit.processId,
      terminal: false,
      readySent: false,
      messageHandlers: new Set(),
      stopHandlers: new Set(),
    };
    activeProcess = processState;

    initializeSandbox({ allowDynamicCode: processInit.allowDynamicCode === true });
    const mod = await import(processInit.entryPath);
    if (runtimeTerminal || activeProcess !== processState || processState.terminal) return;
    const handler = typeof mod.default === "function"
      ? (mod.default as BackendProcessHandler)
      : typeof mod.run === "function"
        ? (mod.run as BackendProcessHandler)
        : null;

    if (!handler) {
      shutdown(
        "fail",
        `Backend process entry \"${processInit.entry}\" must export a default function or named \"run\" function`
      );
      return;
    }

    const ctx: BackendProcessContext = {
      processId: processInit.processId,
      entry: processInit.entry,
      kind: processInit.kind,
      ...(processInit.key ? { key: processInit.key } : {}),
      ...(Object.hasOwn(processInit, "payload") ? { payload: processInit.payload } : {}),
      ...(Object.hasOwn(processInit, "metadata") ? { metadata: processInit.metadata } : {}),
      ...(processInit.userId ? { userId: processInit.userId } : {}),
      ready() {
        if (!activeProcess || activeProcess.terminal || activeProcess.readySent) return;
        activeProcess.readySent = true;
        post({ type: "ready" });
      },
      heartbeat() {
        if (!activeProcess || activeProcess.terminal) return;
        post({ type: "heartbeat" });
      },
      send(payload: unknown) {
        if (!activeProcess || activeProcess.terminal) return;
        post({ type: "message", payload });
      },
      onMessage(handler: MessageHandler) {
        activeProcess?.messageHandlers.add(handler);
        return () => {
          activeProcess?.messageHandlers.delete(handler);
        };
      },
      complete(_result?: unknown) {
        shutdown("complete");
      },
      fail(error: string) {
        shutdown("fail", error);
      },
      onStop(handler: StopHandler) {
        activeProcess?.stopHandlers.add(handler);
        return () => {
          activeProcess?.stopHandlers.delete(handler);
        };
      },
    };

    const cleanup = await handler(ctx);
    if (
      typeof cleanup === "function" &&
      activeProcess === processState &&
      !processState.terminal &&
      !runtimeTerminal
    ) {
      processState.cleanup = cleanup;
    }
  } catch (err) {
    if (runtimeTerminal || (processState && (activeProcess !== processState || processState.terminal))) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    shutdown("fail", message);
  }
}

function handleStop(reason?: string): void {
  const processState = activeProcess;
  if (runtimeTerminal || processState?.terminal) return;

  if (!processState || processState.stopHandlers.size === 0) {
    shutdown("stopped");
    return;
  }

  for (const handler of processState.stopHandlers) {
    try {
      handler({ reason });
    } catch (err) {
      console.error("[Spindle backend process] Stop handler failed:", err);
    }
  }
}

function handleMessage(payload: unknown): void {
  const processState = activeProcess;
  if (!processState || processState.terminal) return;

  for (const handler of processState.messageHandlers) {
    try {
      handler(payload);
    } catch (err) {
      console.error("[Spindle backend process] Message handler failed:", err);
    }
  }
}

function onHostMessage(message: unknown): void {
  if (!isRecord(message)) {
    shutdown("fail", "Invalid backend process message");
    return;
  }

  switch (message.type) {
    case "init":
      void handleInit(message);
      break;
    case "stop": {
      const reason = message.reason;
      if (reason !== undefined && typeof reason !== "string") {
        shutdown("fail", "Invalid backend process message");
        break;
      }
      handleStop(reason);
      break;
    }
    case "message":
      if (!Object.hasOwn(message, "payload")) {
        shutdown("fail", "Invalid backend process message");
        break;
      }
      handleMessage(message.payload);
      break;
    default:
      shutdown("fail", "Invalid backend process message");
      break;
  }
}

if (typeof process.send === "function") {
  process.on("message", (message) => {
    onHostMessage(message);
  });
} else {
  self.onmessage = (event: MessageEvent<unknown>) => {
    onHostMessage(event.data);
  };
}
