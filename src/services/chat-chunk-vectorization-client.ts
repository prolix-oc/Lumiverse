import { join } from "node:path";
import { DatabaseGenerationCancelledError } from "../db/connection";
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
  | { type: "process_batch"; requestId: string; generation: number; tasks: ChatChunkVectorizationTask[]; timeoutMs?: number }
  | { type: "cancel_generation"; generation: number }
  | { type: "shutdown" };

type SubprocessToHostMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; generation: number; result: ChatChunkVectorizationBatchResult }
  | { type: "error"; requestId?: string; generation?: number; error: string; name?: string; stack?: string };

type PendingBatch = {
  requestId: string;
  generation: number;
  signal: AbortSignal;
  abortListener: (() => void) | null;
  tasks: ChatChunkVectorizationTask[];
  resolve: (result: ChatChunkVectorizationBatchResult) => void;
  reject: (err: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

type VectorizationSubprocess = ReturnType<typeof Bun.spawn>;
type VectorizationSubprocessOptions = {
  cmd: string[];
  env: NodeJS.ProcessEnv;
  stdin: "ignore";
  stdout: "inherit";
  stderr: "inherit";
  serialization: "advanced";
  ipc: (message: unknown) => void;
  onExit: (
    subprocess: VectorizationSubprocess,
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ) => void;
};
type VectorizationSubprocessFactory = (options: VectorizationSubprocessOptions) => VectorizationSubprocess;

const defaultVectorizationSubprocessFactory: VectorizationSubprocessFactory = (options) => Bun.spawn(options);
const DEFAULT_SHUTDOWN_COOPERATIVE_GRACE_MS = 1_000;
let shutdownCooperativeGraceMs = DEFAULT_SHUTDOWN_COOPERATIVE_GRACE_MS;
let vectorizationSubprocessFactory = defaultVectorizationSubprocessFactory;
const READY_TIMEOUT_MS = 30_000;
let forceKillGraceMs = CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS;
export const CHAT_CHUNK_VECTORIZATION_SUBPROCESS_STARTUP_ERROR_NAME = "ChatChunkVectorizationSubprocessStartupError";
let warnedDisabled = false;
let subprocessUnavailableReason: string | null = null;

let subprocess: VectorizationSubprocess | null = null;
let ready = false;
let starting: Promise<void> | null = null;
let resolveStarting: (() => void) | null = null;
let rejectStarting: ((reason?: unknown) => void) | null = null;
let inflight: PendingBatch | null = null;
const queue: PendingBatch[] = [];
let workerGeneration: number | null = null;
let expectedExit = false;
let shutdownRequested = false;
type SubprocessRetirement = {
  proc: VectorizationSubprocess;
  promise: Promise<void>;
  resolve: () => void;
  termTimer: ReturnType<typeof setTimeout> | null;
  forceTimer: ReturnType<typeof setTimeout>;
};
let retirement: SubprocessRetirement | null = null;
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

function clearPendingHooks(item: PendingBatch | null): void {
  if (!item) return;
  if (item.timeout) {
    clearTimeout(item.timeout);
    item.timeout = null;
  }
  if (item.abortListener) {
    item.signal.removeEventListener("abort", item.abortListener);
    item.abortListener = null;
  }
}

function terminateSubprocess(
  proc: VectorizationSubprocess | null,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): void {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {
    /* exit observation remains authoritative */
  }
}

function retireSubprocess(proc: VectorizationSubprocess, cooperativeGraceMs = 0): Promise<void> {
  if (retirement?.proc === proc) return retirement.promise;
  const { promise, resolve } = Promise.withResolvers<void>();
  const terminate = () => terminateSubprocess(proc, "SIGTERM");
  const termTimer = cooperativeGraceMs > 0 ? setTimeout(terminate, cooperativeGraceMs) : null;
  termTimer?.unref?.();
  if (!termTimer) terminate();
  const forceTimer = setTimeout(
    () => terminateSubprocess(proc, "SIGKILL"),
    cooperativeGraceMs + forceKillGraceMs,
  );
  forceTimer.unref?.();
  retirement = { proc, promise, resolve, termTimer, forceTimer };
  expectedExit = true;
  ready = false;
  workerGeneration = null;
  return promise;
}

function rejectQueued(error: Error, generation?: number): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index]!;
    if (generation !== undefined && item.generation !== generation) continue;
    queue.splice(index, 1);
    clearPendingHooks(item);
    item.reject(error);
  }
}

function failInflight(error: Error): void {
  const item = inflight;
  if (!item) return;
  inflight = null;
  clearPendingHooks(item);
  item.reject(error);
}

function handleExit(
  exited: VectorizationSubprocess,
  exitCode: number | null,
  signalCode: number | null,
  error?: Error,
): void {
  if (subprocess !== exited && retirement?.proc !== exited) return;
  const wasExpected = expectedExit;
  const wasShutdown = shutdownRequested;
  const completedRetirement = retirement?.proc === exited ? retirement : null;
  const launchError = buildLaunchError(
    exitCode,
    signalCode,
    error,
    completedRetirement === null && !ready,
  );
  if (completedRetirement) {
    if (completedRetirement.termTimer) clearTimeout(completedRetirement.termTimer);
    clearTimeout(completedRetirement.forceTimer);
    retirement = null;
  }
  if (subprocess === exited) subprocess = null;
  ready = false;
  workerGeneration = null;
  expectedExit = false;
  shutdownRequested = wasShutdown;
  clearStarting(launchError);
  failInflight(launchError);
  if (!wasExpected) {
    console.warn("[vectorization] Chat chunk subprocess exited unexpectedly:", launchError.message);
  }
  completedRetirement?.resolve();
  if (!wasShutdown && queue.length > 0) pumpQueue();
}

function handleMessage(source: VectorizationSubprocess, message: SubprocessToHostMessage): void {
  if (subprocess !== source || !message) return;

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

  if (
    !inflight
    || !("requestId" in message)
    || message.requestId !== inflight.requestId
    || ("generation" in message && message.generation !== inflight.generation)
  ) {
    return;
  }

  const item = inflight;
  inflight = null;
  clearPendingHooks(item);

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
  if (shutdownRequested) {
    return Promise.reject(new Error("Chat chunk vectorization subprocess is shutting down"));
  }
  if (retirement) return retirement.promise.then(() => ensureSubprocess());
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
      void retireSubprocess(subprocess);
    }
    clearStarting(err);
  }, READY_TIMEOUT_MS);

  let launched!: VectorizationSubprocess;
  launched = vectorizationSubprocessFactory({
    cmd: bunCmd(runtimePath),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    serialization: "advanced",
    ipc(message) {
      if (subprocess !== launched) return;
      if (ready) {
        handleMessage(launched, message as SubprocessToHostMessage);
        return;
      }
      clearTimeout(launchTimeout);
      handleMessage(launched, message as SubprocessToHostMessage);
    },
    onExit(exited, exitCode, signalCode, error) {
      clearTimeout(launchTimeout);
      handleExit(exited, exitCode, signalCode, error);
    },
  });
  subprocess = launched;

  return starting.finally(() => {
    clearTimeout(launchTimeout);
  });
}

function dispatch(item: PendingBatch): void {
  if (!subprocess) {
    clearPendingHooks(item);
    item.reject(new Error("Chat chunk vectorization subprocess is not running"));
    return;
  }
  if (workerGeneration !== null && workerGeneration !== item.generation) {
    queue.unshift(item);
    cancelChatChunkVectorizationGeneration(workerGeneration, item.generation);
    return;
  }

  workerGeneration = item.generation;
  inflight = item;
  item.timeout = setTimeout(() => {
    const err = new Error(
      `Chat chunk vectorization subprocess became unresponsive ${Math.floor(CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS / 1000)}s after the cooperative batch timeout`,
    );
    console.warn("[vectorization] Chat chunk subprocess did not honor cooperative batch timeout; terminating subprocess");
    void (subprocess ? retireSubprocess(subprocess) : Promise.resolve());
    failInflight(err);
  }, CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS + CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS);
  try {
    subprocess.send({
      type: "process_batch",
      requestId: item.requestId,
      generation: item.generation,
      tasks: item.tasks,
      timeoutMs: CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS,
    } satisfies HostToSubprocessMessage);
  } catch (err) {
    inflight = null;
    clearPendingHooks(item);
    item.reject(err);
    void (subprocess ? retireSubprocess(subprocess) : Promise.resolve());
  }
}

function pumpQueue(): void {
  if (inflight || queue.length === 0) return;
  const target = queue[0]!;
  void ensureSubprocess().then(
    () => {
      if (inflight || !ready) return;
      const targetIndex = queue.indexOf(target);
      if (targetIndex < 0) return;
      queue.splice(targetIndex, 1);
      dispatch(target);
    },
    (err) => {
      const targetIndex = queue.indexOf(target);
      if (targetIndex < 0) return;
      queue.splice(targetIndex, 1);
      clearPendingHooks(target);
      target.reject(err);
      if (queue.length > 0) pumpQueue();
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
  generation: number,
  signal: AbortSignal,
): Promise<ChatChunkVectorizationBatchResult> {
  if (shutdownRequested) {
    return Promise.reject(new Error("Chat chunk vectorization subprocess is shutting down"));
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const item: PendingBatch = {
      requestId: crypto.randomUUID(),
      generation,
      signal,
      abortListener: null,
      tasks,
      resolve,
      reject,
      timeout: null,
    };
    item.abortListener = () => {
      const reason = signal.reason;
      const currentGeneration = reason instanceof DatabaseGenerationCancelledError
        ? reason.currentGeneration
        : generation + 1;
      cancelChatChunkVectorizationGeneration(generation, currentGeneration);
    };
    signal.addEventListener("abort", item.abortListener, { once: true });
    queue.push(item);
    pumpQueue();
  });
}
export function cancelChatChunkVectorizationGeneration(
  previousGeneration: number,
  currentGeneration: number,
): void {
  const cancellation = new DatabaseGenerationCancelledError(previousGeneration, currentGeneration);
  rejectQueued(cancellation, previousGeneration);

  if (inflight?.generation === previousGeneration) {
    try {
      subprocess?.send({ type: "cancel_generation", generation: previousGeneration } satisfies HostToSubprocessMessage);
    } catch {
      /* termination below is authoritative */
    }
    failInflight(cancellation);
  }

  const staleProcess = subprocess;
  if (staleProcess) {
    ready = false;
    workerGeneration = null;
    clearStarting(cancellation);
    void retireSubprocess(staleProcess).then(() => {
      if (queue.length > 0) pumpQueue();
    });
  } else if (queue.length > 0) {
    pumpQueue();
  }
}

export function shutdownChatChunkVectorizationSubprocess(): Promise<void> {
  if (shutdownRequested) return retirement?.promise ?? Promise.resolve();
  const shutdownError = new Error("Chat chunk vectorization subprocess is shutting down");
  shutdownRequested = true;
  expectedExit = true;
  rejectQueued(shutdownError);
  failInflight(shutdownError);
  clearStarting(shutdownError);
  const retiring = subprocess;
  if (!retiring) return Promise.resolve();
  const observedExit = retireSubprocess(retiring, shutdownCooperativeGraceMs);
  try {
    retiring.send({ type: "shutdown" } satisfies HostToSubprocessMessage);
  } catch {
    // Observed exit remains authoritative.
  }
  return observedExit;
}
export const __test__ = {
  setSubprocessFactory(factory: VectorizationSubprocessFactory): void {
    vectorizationSubprocessFactory = factory;
  },
  setForceKillGraceMs(ms: number): void {
    forceKillGraceMs = ms;
  },
  setShutdownCooperativeGraceMs(ms: number): void {
    shutdownCooperativeGraceMs = ms;
  },
  reset(): void {
    const resetError = new Error("Chat chunk vectorization client test reset");
    rejectQueued(resetError);
    failInflight(resetError);
    clearStarting(resetError);
    const procs = new Set<VectorizationSubprocess>();
    if (subprocess) procs.add(subprocess);
    if (retirement) {
      if (retirement.termTimer) clearTimeout(retirement.termTimer);
      clearTimeout(retirement.forceTimer);
      procs.add(retirement.proc);
      retirement.resolve();
      retirement = null;
    }
    subprocess = null;
    ready = false;
    workerGeneration = null;
    expectedExit = false;
    shutdownRequested = false;
    subprocessUnavailableReason = null;
    warnedDisabled = false;
    forceKillGraceMs = CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS;
    shutdownCooperativeGraceMs = DEFAULT_SHUTDOWN_COOPERATIVE_GRACE_MS;
    vectorizationSubprocessFactory = defaultVectorizationSubprocessFactory;
    for (const proc of procs) terminateSubprocess(proc, "SIGKILL");
  },
  getState(): { queueLength: number; inflight: boolean; subprocess: boolean; retirement: boolean; shutdownRequested: boolean } {
    return {
      queueLength: queue.length,
      inflight: inflight !== null,
      subprocess: subprocess !== null,
      retirement: retirement !== null,
      shutdownRequested,
    };
  },
};
