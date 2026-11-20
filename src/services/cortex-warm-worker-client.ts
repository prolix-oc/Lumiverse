/**
 * Host-side client for the cortex warm-cache worker.
 *
 * Warm jobs fire on *every* generation, so a spawn-per-call would pay the
 * LanceDB + DB init cost constantly. This keeps a reusable worker and feeds it
 * a FIFO queue with concurrency 1 — one heavy LanceDB retrieval at a time, in
 * submission order, so the last warm job for a chat is also the last to write
 * the cache (no stale overwrite). Memory-pressure handling may reap it while
 * idle; the next job recreates it lazily.
 *
 * Per-chat dedup: if a queued (not yet started) job for the same chat is still
 * waiting when a newer one arrives, the older one is dropped and resolved as a
 * no-op — a newer query supersedes it anyway.
 */
import type {
  CortexWarmJob,
  CortexWarmResult,
} from "./cortex-warm-worker";
import * as embeddingsSvc from "./embeddings.service";
import { isInferenceSchedulingEnabled, withInferenceLease } from "./inference-scheduler";

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

/** Release the warm worker only when no request depends on its isolate. */
export function releaseIdleCortexWarmWorker(): number {
  if (!worker || inflight || queue.length > 0) return 0;
  disposeWorker();
  return 1;
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

/**
 * Terminate a worker and wait briefly for its close event (or a bounded
 * timeout) so preemption does not release the admission slot while the isolate
 * is still doing work.
 */
async function terminateWorkerAndWait(target: Worker | null): Promise<void> {
  if (!target) return;
  const closed = new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 150);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    const subscribe = (target as Worker & {
      addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
    }).addEventListener;
    if (typeof subscribe === "function") {
      try {
        subscribe.call(target, "close", finish, { once: true });
      } catch {
        /* older runtimes without a close event fall back to the timeout */
      }
    }
  });
  try {
    target.terminate();
  } catch {
    /* already gone */
  }
  await closed;
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

type PendingAdmission = {
  chatId: string;
  controller: AbortController;
  settled: boolean;
  resolve: (result: CortexWarmResult) => void;
  reject: (err: unknown) => void;
};

/**
 * Jobs waiting for an admission slot, keyed by chat. A newer warm request for
 * the same chat supersedes an older one *before* admission; otherwise the older
 * request sits in the scheduler queue and the newer one cannot replace it until
 * the resource frees.
 */
const pendingAdmissions = new Map<string, PendingAdmission>();

function supersedePendingAdmission(chatId: string): void {
  const existing = pendingAdmissions.get(chatId);
  if (!existing) return;
  pendingAdmissions.delete(chatId);
  existing.settled = true;
  existing.resolve(SUPERSEDED);
  existing.controller.abort(new DOMException("Superseded by a newer warm request", "AbortError"));
}

function runWorkerJob(job: CortexWarmJob, signal: AbortSignal): Promise<CortexWarmResult> {
  return new Promise<CortexWarmResult>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };

    const onAbort = () => {
      if (settled) return;
      const queuedIndex = queue.indexOf(item);
      if (queuedIndex >= 0) {
        queue.splice(queuedIndex, 1);
        finish(() => resolve(SUPERSEDED));
        return;
      }
      if (inflight === item) {
        // Preempted while running: terminate the worker and wait (bounded) for
        // it to stop so the admission slot is actually free before the lease is
        // released. The next queued job gets a fresh worker.
        const target = worker;
        inflight = null;
        worker = null;
        if (target) {
          target.onmessage = null;
          target.onerror = null;
        }
        void terminateWorkerAndWait(target).then(() => {
          finish(() => resolve(SUPERSEDED));
          pump();
        });
      }
    };

    const item: QueueItem = {
      requestId: crypto.randomUUID(),
      chatId: job.chatId,
      job,
      resolve: (result) => finish(() => resolve(result)),
      reject: (err) => finish(() => reject(err)),
    };

    if (signal.aborted) {
      finish(() => resolve(SUPERSEDED));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    // Drop still-queued jobs for this chat — a newer query supersedes them.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].chatId === job.chatId) {
        const stale = queue.splice(i, 1)[0];
        stale.resolve(SUPERSEDED);
      }
    }
    queue.push(item);
    pump();
  });
}

/**
 * Run a cortex warm-cache retrieval off the main thread. Resolves with the
 * computed results (to be mirrored into the host cache by the caller), or a
 * no-op `{ null, null }` when superseded or preempted.
 * Rejects if the worker fails — callers should fall back to in-process work.
 */
export function warmCortexInWorker(job: CortexWarmJob): Promise<CortexWarmResult> {
  supersedePendingAdmission(job.chatId);

  return new Promise<CortexWarmResult>((resolve, reject) => {
    const controller = new AbortController();
    const pending: PendingAdmission = {
      chatId: job.chatId,
      controller,
      settled: false,
      resolve,
      reject,
    };
    pendingAdmissions.set(job.chatId, pending);

    void withInferenceLease(
      {
        userId: job.userId,
        endpoint: isInferenceSchedulingEnabled(job.userId)
          ? embeddingsSvc.resolvePrimaryEmbeddingEndpoint(job.userId)
          : null,
        requestClass: "background",
        purpose: "cortex-warm",
        signal: controller.signal,
      },
      (lease) => {
        if (pendingAdmissions.get(job.chatId) === pending) pendingAdmissions.delete(job.chatId);
        return runWorkerJob(job, lease.signal);
      },
    ).then(
      (result) => {
        if (pending.settled) return;
        pending.settled = true;
        resolve(result);
      },
      (err) => {
        if (pendingAdmissions.get(job.chatId) === pending) pendingAdmissions.delete(job.chatId);
        if (pending.settled) {
          resolve(SUPERSEDED);
          return;
        }
        pending.settled = true;
        reject(err);
      },
    ).finally(() => {
      if (pendingAdmissions.get(job.chatId) === pending) pendingAdmissions.delete(job.chatId);
    });
  });
}

/** Test helper: drop every queued, in-flight, and admission-pending job. */
export function resetCortexWarmWorkerForTests(): void {
  for (const pending of pendingAdmissions.values()) {
    pending.settled = true;
    pending.resolve(SUPERSEDED);
    pending.controller.abort(new DOMException("Reset", "AbortError"));
  }
  pendingAdmissions.clear();
  for (const item of queue.splice(0)) item.resolve(SUPERSEDED);
  if (inflight) {
    const item = inflight;
    inflight = null;
    item.resolve(SUPERSEDED);
  }
  disposeWorker();
}
