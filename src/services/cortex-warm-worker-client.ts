/**
 * Host-side client for the cortex warm-cache worker.
 *
 * Unlike the prompt-assembly worker (spawned and terminated per request), warm
 * jobs fire on *every* generation, so a spawn-per-call would pay the LanceDB +
 * DB init cost constantly. This keeps a single long-lived worker and feeds it a
 * FIFO queue with concurrency 1 — one heavy LanceDB retrieval at a time, in
 * submission order, so the last warm job for a chat is also the last to write
 * the cache (no stale overwrite).
 *
 * Per-chat dedup: if a queued (not yet started) job for the same chat is still
 * waiting when a newer one arrives, the older one is dropped and resolved as a
 * no-op — a newer query supersedes it anyway.
 */
import type {
  CortexWarmJob,
  CortexWarmResult,
} from "./cortex-warm-worker";

export type { CortexWarmJob, CortexWarmResult } from "./cortex-warm-worker";

type WorkerResponse =
  | { type: "result"; requestId: string; result: CortexWarmResult }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string };

type QueueItem = {
  requestId: string;
  chatId: string;
  job: CortexWarmJob;
  resolve: (result: CortexWarmResult) => void;
  reject: (err: unknown) => void;
};

const SUPERSEDED: CortexWarmResult = { mainResult: null, linkedResult: null };

let worker: Worker | null = null;
let inflight: QueueItem | null = null;
const queue: QueueItem[] = [];

/** Operators can force the in-process (blocking) path with this env flag. */
export function canUseCortexWorker(): boolean {
  return process.env.LUMIVERSE_CORTEX_WORKER !== "false";
}

function disposeWorker(): void {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }
}

function handleMessage(event: MessageEvent<WorkerResponse>): void {
  const message = event.data;
  if (!message || !inflight || message.requestId !== inflight.requestId) return;
  const item = inflight;
  inflight = null;
  if (message.type === "result") {
    item.resolve(message.result);
  } else {
    const err = new Error(message.error);
    err.name = message.name || "CortexWarmWorkerError";
    if (message.stack) err.stack = message.stack;
    item.reject(err);
  }
  pump();
}

function handleError(event: ErrorEvent): void {
  const err = new Error(event.message || "Cortex warm worker crashed");
  // The worker is in an unknown state — tear it down so the next job respawns.
  disposeWorker();
  if (inflight) {
    const item = inflight;
    inflight = null;
    item.reject(err);
  }
  pump();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./cortex-warm-worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = handleMessage;
  worker.onerror = handleError;
  return worker;
}

function pump(): void {
  if (inflight || queue.length === 0) return;
  const item = queue.shift()!;
  inflight = item;
  try {
    ensureWorker().postMessage({
      type: "warm",
      requestId: item.requestId,
      job: item.job,
    });
  } catch (err) {
    // Spawn / postMessage failed — reject this job (caller falls back
    // in-process) and reset so the next one can retry a fresh worker.
    inflight = null;
    disposeWorker();
    item.reject(err);
    pump();
  }
}

/**
 * Run a cortex warm-cache retrieval off the main thread. Resolves with the
 * computed results (to be mirrored into the host cache by the caller), or a
 * no-op `{ null, null }` when superseded by a newer job for the same chat.
 * Rejects if the worker fails — callers should fall back to in-process work.
 */
export function warmCortexInWorker(job: CortexWarmJob): Promise<CortexWarmResult> {
  return new Promise<CortexWarmResult>((resolve, reject) => {
    // Drop any still-queued job for this chat — a newer query supersedes it.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].chatId === job.chatId) {
        const stale = queue.splice(i, 1)[0];
        stale.resolve(SUPERSEDED);
      }
    }
    queue.push({
      requestId: crypto.randomUUID(),
      chatId: job.chatId,
      job,
      resolve,
      reject,
    });
    pump();
  });
}
