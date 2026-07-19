import { join } from "node:path";
import { bunCmd } from "../utils/bun-cmd";
import {
  CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS,
  CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS,
  CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS,
} from "./chat-chunk-vectorization-timeouts";
import type {
  ChatChunkVectorizationBatchResult,
  ChatChunkVectorizationTask,
} from "./chat-chunk-vectorization-runner";

type HostToSubprocessMessage =
  | { type: "process_batch"; requestId: string; tasks: ChatChunkVectorizationTask[]; timeoutMs?: number }
  | { type: "shutdown" };

type SubprocessToHostMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; result: ChatChunkVectorizationBatchResult }
  | { type: "error"; requestId?: string; error: string; name?: string; stack?: string };

type PendingBatch = {
  requestId: string;
  tasks: ChatChunkVectorizationTask[];
  resolve: (result: ChatChunkVectorizationBatchResult) => void;
  reject: (err: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

const READY_TIMEOUT_MS = 30_000;
export const CHAT_CHUNK_VECTORIZATION_SUBPROCESS_STARTUP_ERROR_NAME = "ChatChunkVectorizationSubprocessStartupError";
let warnedDisabled = false;
let subprocessUnavailableReason: string | null = null;

let subprocess: ReturnType<typeof Bun.spawn> | null = null;
let ready = false;
let starting: Promise<void> | null = null;
let resolveStarting: (() => void) | null = null;
let rejectStarting: ((reason?: unknown) => void) | null = null;
let inflight: PendingBatch | null = null;
const queue: PendingBatch[] = [];
let expectedExit = false;
let shutdownRequested = false;

function createStartupError(message: string, stack?: string): Error {
  const err = new Error(message);
  err.name = CHAT_CHUNK_VECTORIZATION_SUBPROCESS_STARTUP_ERROR_NAME;
  if (stack) err.stack = stack;
  return err;
}

export function isChatChunkVectorizationSubprocessStartupError(err: unknown): err is Error {
  return err instanceof Error && err.name === CHAT_CHUNK_VECTORIZATION_SUBPROCESS_STARTUP_ERROR_NAME;
}

function buildLaunchError(
  exitCode: number | null,
  signalCode: number | null,
  error?: Error,
  startup = false,
): Error {
  const message = error?.message
    || `Chat chunk vectorization subprocess exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
  if (!startup) return new Error(message);
  return createStartupError(message, error?.stack);
}

function clearStarting(error?: unknown): void {
  const reject = rejectStarting;
  const resolve = resolveStarting;
  starting = null;
  resolveStarting = null;
  rejectStarting = null;
  if (error) {
    if (isChatChunkVectorizationSubprocessStartupError(error)) {
      subprocessUnavailableReason = error.message;
    }
    reject?.(error);
    return;
  }
  resolve?.();
}

function clearInflightTimeout(item: PendingBatch | null): void {
  if (item?.timeout) {
    clearTimeout(item.timeout);
    item.timeout = null;
  }
}

function terminateSubprocess(
  proc: ReturnType<typeof Bun.spawn> | null,
  {
    forceAfterMs,
    signal = "SIGTERM",
  }: {
    forceAfterMs?: number;
    signal?: "SIGTERM" | "SIGKILL";
  } = {},
): void {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {
    return;
  }
  if (!forceAfterMs || signal === "SIGKILL") return;
  setTimeout(() => {
    if (subprocess !== proc) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }, forceAfterMs);
}

function rejectQueued(error: Error): void {
  while (queue.length > 0) {
    queue.shift()!.reject(error);
  }
}

function failInflight(error: Error): void {
  const item = inflight;
  if (!item) return;
  inflight = null;
  clearInflightTimeout(item);
  item.reject(error);
}

function handleExit(exitCode: number | null, signalCode: number | null, error?: Error): void {
  const wasExpected = expectedExit;
  const wasShutdown = shutdownRequested;
  const wasReady = ready;
  const launchError = buildLaunchError(exitCode, signalCode, error, !wasReady);
  subprocess = null;
  ready = false;
  expectedExit = false;
  shutdownRequested = false;
  clearStarting(launchError);
  failInflight(launchError);
  if (!wasExpected) {
    console.warn("[vectorization] Chat chunk subprocess exited unexpectedly:", launchError.message);
  }
  if (!wasShutdown && queue.length > 0) {
    pumpQueue();
  }
}

function handleMessage(message: SubprocessToHostMessage): void {
  if (!message) return;

  if (message.type === "ready") {
    ready = true;
    clearStarting();
    pumpQueue();
    return;
  }

  if (message.type === "error" && !message.requestId) {
    const err = createStartupError(message.error, message.stack);
    clearStarting(err);
    return;
  }

  if (!inflight || !("requestId" in message) || message.requestId !== inflight.requestId) {
    return;
  }

  const item = inflight;
  inflight = null;
  clearInflightTimeout(item);

  if (message.type === "result") {
    item.resolve(message.result);
  } else {
    const err = new Error(message.error);
    err.name = message.name || "ChatChunkVectorizationSubprocessError";
    if (message.stack) err.stack = message.stack;
    item.reject(err);
  }

  pumpQueue();
}

function ensureSubprocess(): Promise<void> {
  if (subprocess && ready) return Promise.resolve();
  if (subprocessUnavailableReason) {
    return Promise.reject(createStartupError(subprocessUnavailableReason));
  }
  if (starting) return starting;

  starting = new Promise<void>((resolve, reject) => {
    resolveStarting = resolve;
    rejectStarting = reject;
  });

  const runtimePath = join(import.meta.dir, "chat-chunk-vectorization-subprocess.ts");
  const launchTimeout = setTimeout(() => {
    const err = createStartupError(
      `Chat chunk vectorization subprocess did not become ready within ${READY_TIMEOUT_MS}ms`,
    );
    if (subprocess) {
      expectedExit = true;
      terminateSubprocess(subprocess, { forceAfterMs: CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS });
    }
    clearStarting(err);
  }, READY_TIMEOUT_MS);

  subprocess = Bun.spawn({
    cmd: bunCmd(runtimePath),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    serialization: "advanced",
    ipc(message) {
      if (ready) {
        handleMessage(message as SubprocessToHostMessage);
        return;
      }
      clearTimeout(launchTimeout);
      handleMessage(message as SubprocessToHostMessage);
    },
    onExit(_subprocess, exitCode, signalCode, error) {
      clearTimeout(launchTimeout);
      handleExit(exitCode, signalCode, error);
    },
  });

  return starting.finally(() => {
    clearTimeout(launchTimeout);
  });
}

function dispatch(item: PendingBatch): void {
  if (!subprocess) {
    item.reject(new Error("Chat chunk vectorization subprocess is not running"));
    return;
  }

  inflight = item;
  item.timeout = setTimeout(() => {
    const err = new Error(
      `Chat chunk vectorization subprocess became unresponsive ${Math.floor(CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS / 1000)}s after the cooperative batch timeout`,
    );
    console.warn("[vectorization] Chat chunk subprocess did not honor cooperative batch timeout; terminating subprocess");
    expectedExit = true;
    terminateSubprocess(subprocess, { forceAfterMs: CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS });
    failInflight(err);
  }, CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS + CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS);
  try {
    subprocess.send({
      type: "process_batch",
      requestId: item.requestId,
      tasks: item.tasks,
      timeoutMs: CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS,
    } satisfies HostToSubprocessMessage);
  } catch (err) {
    inflight = null;
    clearInflightTimeout(item);
    item.reject(err);
    expectedExit = true;
    terminateSubprocess(subprocess, { forceAfterMs: CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS });
  }
}

function pumpQueue(): void {
  if (inflight || queue.length === 0) return;
  void ensureSubprocess().then(
    () => {
      if (inflight || queue.length === 0 || !ready) return;
      const item = queue.shift()!;
      dispatch(item);
    },
    (err) => {
      const item = queue.shift();
      if (item) item.reject(err);
    },
  );
}

export function canUseChatChunkVectorizationSubprocess(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const explicit = env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS;
  if (explicit === "false") return false;
  if (platform === "win32" && explicit !== "true") return false;
  if (subprocessUnavailableReason) return false;
  return true;
}

export function warnChatChunkVectorizationFallback(): void {
  if (warnedDisabled || canUseChatChunkVectorizationSubprocess()) return;
  warnedDisabled = true;
  if (process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS === "false") {
    console.warn(
      "[vectorization] Chat chunk vectorization subprocess disabled via LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS=false; falling back to in-process execution.",
    );
    return;
  }
  if (process.platform === "win32" && process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS !== "true") {
    console.warn(
      "[vectorization] Chat chunk vectorization subprocess is disabled on Windows by default because this Bun.spawn IPC path has been unstable there. Set LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS=true to re-enable it.",
    );
    return;
  }
  if (subprocessUnavailableReason) {
    console.warn(
      `[vectorization] Chat chunk vectorization subprocess disabled for this server process after bootstrap failure (${subprocessUnavailableReason}); falling back to in-process execution.`,
    );
    return;
  }
  console.warn("[vectorization] Chat chunk vectorization subprocess unavailable; falling back to in-process execution.");
}

export function processChatChunkVectorizationBatchInSubprocess(
  tasks: ChatChunkVectorizationTask[],
): Promise<ChatChunkVectorizationBatchResult> {
  return new Promise((resolve, reject) => {
    queue.push({
      requestId: crypto.randomUUID(),
      tasks,
      resolve,
      reject,
      timeout: null,
    });
    pumpQueue();
  });
}

export function shutdownChatChunkVectorizationSubprocess(): void {
  const shutdownError = new Error("Chat chunk vectorization subprocess is shutting down");
  shutdownRequested = true;
  expectedExit = true;
  rejectQueued(shutdownError);
  failInflight(shutdownError);
  if (!subprocess) {
    shutdownRequested = false;
    expectedExit = false;
    return;
  }
  try {
    subprocess.send({ type: "shutdown" } satisfies HostToSubprocessMessage);
  } catch {
    try {
      subprocess.kill("SIGTERM");
    } catch {
      /* noop */
    }
  }
}
