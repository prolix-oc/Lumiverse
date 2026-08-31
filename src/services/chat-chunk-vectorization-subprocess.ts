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
  | { type: "process_batch"; requestId: string; generation: number; tasks: ChatChunkVectorizationTask[]; timeoutMs?: number }
  | { type: "cancel_generation"; generation: number }
  | { type: "shutdown" };

type SubprocessToHostMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; generation: number; result: ChatChunkVectorizationBatchResult }
  | { type: "error"; requestId?: string; generation?: number; error: string; name?: string; stack?: string };

let initialized: Promise<void> | null = null;
let activeGeneration: number | null = null;
let activeController: AbortController | null = null;

function send(message: SubprocessToHostMessage): void {
  if (typeof process.send === "function") process.send(message);
}
function describeError(err: unknown): { error: string; name?: string; stack?: string } {
  if (err instanceof Error) return { error: err.message, name: err.name, stack: err.stack };
  return { error: String(err) };
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

function createBatchController(timeoutMs?: number): { controller: AbortController; cleanup: () => void } {
  const effectiveTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(0, Math.floor(timeoutMs))
    : 0;
  const controller = new AbortController();
  if (effectiveTimeoutMs <= 0) return { controller, cleanup: () => {} };

  const timer = setTimeout(() => {
    console.warn("[vectorization] Chat chunk subprocess batch deadline reached; aborting remaining work without restart");
    controller.abort(createChatChunkVectorizationBatchTimeoutError(effectiveTimeoutMs));
  }, effectiveTimeoutMs);
  return { controller, cleanup: () => clearTimeout(timer) };
}

async function handleProcessBatch(
  message: Extract<HostToSubprocessMessage, { type: "process_batch" }>,
): Promise<void> {
  await ensureInitialized();
  if (activeGeneration !== null && activeGeneration !== message.generation) {
    throw new Error(`Vector worker generation ${activeGeneration} cannot process generation ${message.generation}`);
  }
  activeGeneration = message.generation;
  const { controller, cleanup } = createBatchController(message.timeoutMs);
  activeController = controller;
  try {
    const result = await processChatChunkVectorizationBatch(message.tasks, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    send({
      type: "result",
      requestId: message.requestId,
      generation: message.generation,
      result,
    });
  } finally {
    cleanup();
    if (activeController === controller) activeController = null;
  }
}

function handleMessage(message: HostToSubprocessMessage): void {
  if (!message) return;
  if (message.type === "shutdown") {
    process.exit(0);
    return;
  }
  if (message.type === "cancel_generation") {
    if (activeGeneration === message.generation) {
      activeController?.abort(new DOMException("Database generation cancelled", "AbortError"));
    }
    // A subprocess owns one host generation. Exit even when idle so a reopened
    // host database can never reuse this process's SQLite/Lance handles.
    process.exit(0);
    return;
  }

  handleProcessBatch(message).catch((err: unknown) => {
    send({
      type: "error",
      requestId: message.requestId,
      generation: message.generation,
      ...describeError(err),
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
  (err: unknown) => {
    send({
      type: "error",
      ...describeError(err),
    });
    process.exit(1);
  },
);
