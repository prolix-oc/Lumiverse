import os from "node:os";
import type { AssemblyContext, AssemblyResult } from "../llm/types";
import { registry } from "../macros";
import { macroInterceptorChain } from "../spindle/macro-interceptor";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import { resolveConnection } from "./connections.service";
import { getTokenizerIdForModel, onTokenizerInvalidation } from "./tokenizer.service";
import { releaseTokenizerResourceLocks } from "./tokenizer-resource-cache";
import type { AssemblyWorkerRequest, AssemblyWorkerResponse } from "./prompt-assembly-worker-protocol";
import { getCortexCacheSnapshot } from "./memory-cortex";
import { scheduleCortexPromptWarm } from "./cortex-prompt-warm.service";

function workerDisabledByEnv(): boolean {
  return process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER === "false";
}

function hasMainProcessOnlyMacros(): boolean {
  return registry.getAllMacros().some((macro) => !macro.builtIn);
}

export function canUsePromptAssemblyWorker(): boolean {
  if (workerDisabledByEnv()) return false;
  // Extension macros are registered in the main process and cannot yet execute
  // inside the assembly worker. Keep behavior correct by falling back to the
  // in-process pipeline when any non-built-in macro is registered.
  if (hasMainProcessOnlyMacros()) return false;
  if (macroInterceptorChain.count > 0) return false;
  if (worldInfoInterceptorChain.count > 0) return false;
  return true;
}

// ─── Worker pool ──────────────────────────────────────────────────────────
//
// Assembly workers are REUSED rather than spawned-and-terminated per request.
// A fresh isolate pays the tokenizer module cold-load every generation (GLM
// ~1.1s, Claude ~130ms) and starts the token-count + databank result caches
// empty — so a per-call worker never benefits from the cross-generation
// caching that makes regenerate/swipe cheap. A reused worker loads tokenizers
// once and keeps those caches warm.
//
// One job per worker at a time; concurrent assemblies (council mode, multiple
// tabs) fan out across the pool. Workers are evicted after a quiet period so an
// idle instance doesn't hold tokenizer/LanceDB memory indefinitely.

const IDLE_TTL_MS = (() => {
  const requested = Number(process.env.LUMIVERSE_PROMPT_ASSEMBLY_IDLE_MS);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(30_000, Math.min(requested, 30 * 60_000)) : 10 * 60_000;
})();
const DEFAULT_MAX_WORKERS = 2;

const MAX_WORKERS = (() => {
  const raw = Number(process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS);
  const want = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_WORKERS;
  let ceil = DEFAULT_MAX_WORKERS;
  try {
    ceil = Math.max(1, os.availableParallelism() - 1);
  } catch {
    /* availableParallelism unavailable — keep the default ceiling */
  }
  return Math.max(1, Math.min(want, ceil));
})();

interface Job {
  requestId: string;
  ctx: Omit<AssemblyContext, "signal" | "prefetched">;
  chatId: string | null;
  tokenizerId: string | null;
  signal?: AbortSignal;
  resolve: (result: AssemblyResult) => void;
  reject: (err: unknown) => void;
  onAbort?: () => void;
  settled: boolean;
}

interface PoolWorker {
  worker: Worker;
  job: Job | null;
  /** Last chat assembled here — used for sticky routing so a regenerate reuses
   *  the worker whose token/databank caches are already warm for that chat. */
  lastChatId: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  tokenizerIds: string[];
  warming: { requestId: string; tokenizerId: string } | null;
  resourceOwner: string;
}

const pool: PoolWorker[] = [];
const waiting: Job[] = [];
let tokenizerRevision = 0;

onTokenizerInvalidation((tokenizerId) => {
  tokenizerRevision++;
  for (const pw of pool) {
    pw.tokenizerIds = tokenizerId === null ? [] : pw.tokenizerIds.filter(id => id !== tokenizerId);
    pw.worker.postMessage({ type: "invalidate-tokenizer", tokenizerId } satisfies AssemblyWorkerRequest);
  }
});

function settleJob(job: Job, fn: () => void): void {
  if (job.settled) return;
  job.settled = true;
  if (job.signal && job.onAbort) {
    job.signal.removeEventListener("abort", job.onAbort);
  }
  fn();
}

function spawnWorker(): PoolWorker {
  const worker = new Worker(new URL("./prompt-assembly-worker.ts", import.meta.url), {
    type: "module",
  });
  const pw: PoolWorker = { worker, job: null, lastChatId: null, idleTimer: null, tokenizerIds: [], warming: null, resourceOwner: crypto.randomUUID() };
  worker.onmessage = (event: MessageEvent<AssemblyWorkerResponse>) => onMessage(pw, event.data);
  worker.onerror = (event) => onError(pw, event.message || "Prompt assembly worker crashed");
  pool.push(pw);
  return pw;
}

function destroyWorker(pw: PoolWorker): void {
  const idx = pool.indexOf(pw);
  if (idx >= 0) pool.splice(idx, 1);
  if (pw.idleTimer) {
    clearTimeout(pw.idleTimer);
    pw.idleTimer = null;
  }
  pw.worker.onmessage = null;
  pw.worker.onerror = null;
  pw.worker.terminate();
  void releaseTokenizerResourceLocks(pw.resourceOwner).catch(() => {});
}

/** Terminate only workers that are not serving a prompt or queueing work. */
export function releaseIdlePromptAssemblyWorkers(): number {
  if (waiting.length > 0) return 0;
  let released = 0;
  for (const pw of [...pool]) {
    if (pw.job) continue;
    destroyWorker(pw);
    released++;
  }
  return released;
}

function markIdle(pw: PoolWorker): void {
  if (pw.idleTimer) clearTimeout(pw.idleTimer);
  pw.idleTimer = setTimeout(() => {
    pw.idleTimer = null;
    if (!pw.job && !pw.warming) destroyWorker(pw);
  }, IDLE_TTL_MS);
}

function onMessage(pw: PoolWorker, msg: AssemblyWorkerResponse | undefined): void {
  if (!msg) return;
  if ((msg.type === "tokenizer-warmed" || msg.type === "result") && msg.tokenizerRevision === tokenizerRevision) {
    pw.tokenizerIds = msg.tokenizerIds;
  }
  if (pw.warming?.requestId === msg.requestId) {
    pw.warming = null;
    if (!pw.job) markIdle(pw);
    drain();
    return;
  }
  if (msg.type === "tokenizer-warmed") return;
  const job = pw.job;
  if (!job || !msg || msg.requestId !== job.requestId) return;
  pw.job = null;
  if (msg.type === "result") {
    settleJob(job, () => {
      const { deferredCortexWarmJob, ...result } = msg.result;
      if (deferredCortexWarmJob && !job.signal?.aborted) {
        scheduleCortexPromptWarm(job.ctx.userId, job.ctx.chatId, deferredCortexWarmJob, job.signal);
      }
      job.resolve(result);
    });
  } else {
    const err = new Error(msg.error);
    err.name = msg.name || "PromptAssemblyWorkerError";
    if (msg.stack) err.stack = msg.stack;
    settleJob(job, () => job.reject(err));
  }
  markIdle(pw);
  drain();
}

function onError(pw: PoolWorker, message: string): void {
  const job = pw.job;
  pw.job = null;
  // The worker is in an unknown state — discard it so a fresh one respawns.
  destroyWorker(pw);
  // Reject the in-flight job (generate.service falls back to in-process).
  if (job) settleJob(job, () => job.reject(new Error(message)));
  drain();
}

function abortJob(job: Job): void {
  if (job.settled) return;
  // Still queued — just drop it.
  const wIdx = waiting.indexOf(job);
  if (wIdx >= 0) waiting.splice(wIdx, 1);
  // In-flight — the worker's CPU-bound assembly can't be cancelled (the signal
  // is stripped before postMessage), so discard the worker to stop the work.
  const pw = pool.find((p) => p.job === job);
  if (pw) {
    pw.job = null;
    destroyWorker(pw);
  }
  settleJob(job, () =>
    job.reject(job.signal?.reason ?? new DOMException("Aborted", "AbortError")),
  );
  drain();
}

function assign(pw: PoolWorker, job: Job): void {
  if (pw.idleTimer) {
    clearTimeout(pw.idleTimer);
    pw.idleTimer = null;
  }
  pw.job = job;
  pw.lastChatId = job.chatId;
  pw.worker.postMessage({
    type: "assemble",
    requestId: job.requestId,
    ctx: { ...job.ctx, cortexCache: getCortexCacheSnapshot(job.ctx.chatId) },
    tokenizerRevision,
    resourceOwner: pw.resourceOwner,
  } satisfies AssemblyWorkerRequest);
}

function pickIdleWorker(chatId: string | null, tokenizerId: string | null): PoolWorker | null {
  let best: PoolWorker | null = null;
  let bestScore = -1;
  for (const pw of pool) {
    if (pw.job) continue;
    const warm = tokenizerId && (pw.tokenizerIds.includes(tokenizerId) || pw.warming?.tokenizerId === tokenizerId);
    const score = (warm ? 2 : 0) + (chatId && pw.lastChatId === chatId ? 1 : 0);
    if (score > bestScore) { best = pw; bestScore = score; }
  }
  return best;
}

function drain(): void {
  while (waiting.length > 0) {
    const next = waiting[0];
    let pw = pickIdleWorker(next.chatId, next.tokenizerId);
    if (!pw && pool.length < MAX_WORKERS) pw = spawnWorker();
    if (!pw) break; // all busy and at capacity — wait for a worker to free up
    waiting.shift();
    assign(pw, next);
  }
}

export function assemblePromptInWorker(ctx: AssemblyContext): Promise<AssemblyResult> {
  const { signal, prefetched: _prefetched, ...workerCtx } = ctx;

  return new Promise<AssemblyResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const job: Job = {
      requestId: crypto.randomUUID(),
      ctx: workerCtx,
      chatId: workerCtx.chatId ?? null,
      tokenizerId: getTokenizerIdForModel(resolveConnection(ctx.userId, ctx.connectionId)?.model ?? ""),
      signal,
      resolve,
      reject,
      settled: false,
    };

    if (signal) {
      job.onAbort = () => abortJob(job);
      signal.addEventListener("abort", job.onAbort, { once: true });
    }

    waiting.push(job);
    drain();
  });
}

/** Speculative warmup never queues ahead of generation or expands an active pool. */
export function warmPromptAssemblyTokenizer(modelId: string, chatId: string | null): void {
  if (!canUsePromptAssemblyWorker() || waiting.length > 0) return;
  const tokenizerId = getTokenizerIdForModel(modelId);
  if (!tokenizerId) return;
  if (pool.some(pw => pw.tokenizerIds.includes(tokenizerId) || pw.warming?.tokenizerId === tokenizerId)) return;
  const pw = pickIdleWorker(chatId, tokenizerId) ?? (pool.length === 0 ? spawnWorker() : null);
  if (!pw || pw.warming) return;
  if (pw.idleTimer) { clearTimeout(pw.idleTimer); pw.idleTimer = null; }
  const requestId = crypto.randomUUID();
  pw.warming = { requestId, tokenizerId };
  pw.worker.postMessage({ type: "warm-tokenizer", requestId, modelId, tokenizerRevision, resourceOwner: pw.resourceOwner } satisfies AssemblyWorkerRequest);
}
