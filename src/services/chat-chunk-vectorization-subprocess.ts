import { configureLanceDbNativeOverride } from "../lancedb-preflight";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
import { createChatChunkVectorizationBatchTimeoutError } from "./chat-chunk-vectorization-timeouts";
import {
  processChatChunkVectorizationBatch,
  type ChatChunkVectorizationBatchResult,
  type ChatChunkVectorizationTask,
} from "./chat-chunk-vectorization-runner";

type HostToSubprocessMessage =
  | { type: "process_batch"; requestId: string; tasks: ChatChunkVectorizationTask[]; timeoutMs?: number }
  | { type: "shutdown" };

type SubprocessToHostMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; result: ChatChunkVectorizationBatchResult }
  | { type: "error"; requestId?: string; error: string; name?: string; stack?: string };

let initialized: Promise<void> | null = null;

function send(message: SubprocessToHostMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await configureLanceDbNativeOverride();
      await initIdentity();
      initDatabase();
    })();
  }
  return initialized;
}

function createBatchSignal(timeoutMs?: number): { signal: AbortSignal | undefined; cleanup: () => void } {
  const effectiveTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(0, Math.floor(timeoutMs))
    : 0;
  if (effectiveTimeoutMs <= 0) {
    return {
      signal: undefined,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.warn("[vectorization] Chat chunk subprocess batch deadline reached; aborting remaining work without restart");
    controller.abort(createChatChunkVectorizationBatchTimeoutError(effectiveTimeoutMs));
  }, effectiveTimeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function handleProcessBatch(message: Extract<HostToSubprocessMessage, { type: "process_batch" }>): Promise<void> {
  await ensureInitialized();
  const { signal, cleanup } = createBatchSignal(message.timeoutMs);
  try {
    const result = await processChatChunkVectorizationBatch(message.tasks, { signal });
    send({
      type: "result",
      requestId: message.requestId,
      result,
    });
  } finally {
    cleanup();
  }
}

function handleMessage(message: HostToSubprocessMessage): void {
  if (!message) return;
  if (message.type === "shutdown") {
    process.exit(0);
    return;
  }

  handleProcessBatch(message).catch((err: any) => {
    send({
      type: "error",
      requestId: message.requestId,
      error: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
    });
  });
}

if (typeof process.send !== "function") {
  throw new Error("Chat chunk vectorization subprocess requires IPC-enabled process.send()");
}

process.on("message", (message) => {
  handleMessage(message as HostToSubprocessMessage);
});

void ensureInitialized().then(
  () => send({ type: "ready" }),
  (err: any) => {
    send({
      type: "error",
      error: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
    });
    process.exit(1);
  },
);
