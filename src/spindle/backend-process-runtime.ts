type BackendProcessInit = {
  processId: string;
  entry: string;
  kind: string;
  entryPath: string;
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
  payload: unknown;
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

function post(message: BackendProcessToHost): void {
  if (typeof process.send === "function") {
    process.send(message);
    return;
  }
  self.postMessage(message);
}

function shutdown(kind: "complete" | "fail" | "stopped", error?: string): void {
  const processState = activeProcess;
  if (processState?.terminal) return;
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

  if (kind === "fail") {
    post({ type: "fail", error: error?.trim() || "Backend process failed" });
    process.exit(1);
    return;
  }

  post({ type: kind });
  process.exit(0);
}

async function handleInit(msg: Extract<HostToBackendProcess, { type: "init" }>): Promise<void> {
  try {
    const mod = await import(msg.process.entryPath);
    const handler = typeof mod.default === "function"
      ? (mod.default as BackendProcessHandler)
      : typeof mod.run === "function"
        ? (mod.run as BackendProcessHandler)
        : null;

    if (!handler) {
      shutdown(
        "fail",
        `Backend process entry \"${msg.process.entry}\" must export a default function or named \"run\" function`
      );
      return;
    }

    const processState: ActiveBackendProcess = {
      processId: msg.process.processId,
      terminal: false,
      readySent: false,
      messageHandlers: new Set(),
      stopHandlers: new Set(),
    };
    activeProcess = processState;

    const ctx: BackendProcessContext = {
      processId: msg.process.processId,
      entry: msg.process.entry,
      kind: msg.process.kind,
      ...(msg.process.key ? { key: msg.process.key } : {}),
      payload: msg.process.payload,
      ...(msg.process.metadata ? { metadata: msg.process.metadata } : {}),
      ...(msg.process.userId ? { userId: msg.process.userId } : {}),
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
    if (typeof cleanup === "function" && activeProcess) {
      activeProcess.cleanup = cleanup;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    shutdown("fail", message);
  }
}

function handleStop(reason?: string): void {
  const processState = activeProcess;
  if (!processState || processState.terminal) return;

  if (processState.stopHandlers.size === 0) {
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

function onHostMessage(message: HostToBackendProcess): void {
  switch (message.type) {
    case "init":
      void handleInit(message);
      break;
    case "stop":
      handleStop(message.reason);
      break;
    case "message":
      handleMessage(message.payload);
      break;
  }
}

if (typeof process.send === "function") {
  process.on("message", (message) => {
    onHostMessage(message as HostToBackendProcess);
  });
} else {
  self.onmessage = (event: MessageEvent<HostToBackendProcess>) => {
    onHostMessage(event.data);
  };
}
