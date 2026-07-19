import os from "node:os";
import type {
  ParsedWebPage,
  WebPageParseErrorCode,
} from "./web-page-parser";

type WorkerResponse =
  | { type: "result"; requestId: string; result: ParsedWebPage }
  | {
      type: "error";
      requestId: string;
      error: string;
      code: WebPageParseErrorCode;
    };

interface ParseJob {
  requestId: string;
  html: string;
  url: string;
  resolve: (result: ParsedWebPage) => void;
  reject: (err: unknown) => void;
}

interface PoolWorker {
  worker: Worker;
  job: ParseJob | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class WebPageParserWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: WebPageParseErrorCode,
  ) {
    super(message);
    this.name = "WebPageParserWorkerError";
  }
}

const IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_WORKERS = 2;
const MAX_WORKERS = (() => {
  let available = DEFAULT_MAX_WORKERS + 1;
  try {
    available = os.availableParallelism();
  } catch {
    // Keep the conservative default when the runtime cannot report CPU count.
  }
  // Always leave one logical CPU available for the main server event loop.
  return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, available - 1));
})();

const pool: PoolWorker[] = [];
const waiting: ParseJob[] = [];

function destroyWorker(poolWorker: PoolWorker): void {
  const index = pool.indexOf(poolWorker);
  if (index >= 0) pool.splice(index, 1);
  if (poolWorker.idleTimer) clearTimeout(poolWorker.idleTimer);
  poolWorker.worker.onmessage = null;
  poolWorker.worker.onerror = null;
  poolWorker.worker.terminate();
}

function markIdle(poolWorker: PoolWorker): void {
  if (poolWorker.idleTimer) clearTimeout(poolWorker.idleTimer);
  poolWorker.idleTimer = setTimeout(() => {
    poolWorker.idleTimer = null;
    if (!poolWorker.job) destroyWorker(poolWorker);
  }, IDLE_TTL_MS);
}

function handleMessage(poolWorker: PoolWorker, message: WorkerResponse): void {
  const job = poolWorker.job;
  if (!job || !message || message.requestId !== job.requestId) return;
  poolWorker.job = null;

  if (message.type === "result") {
    job.resolve(message.result);
  } else {
    job.reject(new WebPageParserWorkerError(message.error, message.code));
  }

  markIdle(poolWorker);
  drain();
}

function handleError(poolWorker: PoolWorker, message: string): void {
  const job = poolWorker.job;
  poolWorker.job = null;
  destroyWorker(poolWorker);
  job?.reject(new Error(message || "Web page parser worker crashed"));
  drain();
}

function spawnWorker(): PoolWorker {
  const worker = new Worker(new URL("./web-page-parser-worker.ts", import.meta.url), {
    type: "module",
  });
  const poolWorker: PoolWorker = { worker, job: null, idleTimer: null };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    handleMessage(poolWorker, event.data);
  };
  worker.onerror = (event) => {
    handleError(poolWorker, event.message);
  };
  pool.push(poolWorker);
  return poolWorker;
}

function assign(poolWorker: PoolWorker, job: ParseJob): void {
  if (poolWorker.idleTimer) {
    clearTimeout(poolWorker.idleTimer);
    poolWorker.idleTimer = null;
  }
  poolWorker.job = job;
  try {
    poolWorker.worker.postMessage({
      type: "parse",
      requestId: job.requestId,
      html: job.html,
      url: job.url,
    });
  } catch (err) {
    poolWorker.job = null;
    destroyWorker(poolWorker);
    job.reject(err);
  }
}

function drain(): void {
  while (waiting.length > 0) {
    let poolWorker = pool.find((candidate) => !candidate.job) ?? null;
    if (!poolWorker && pool.length < MAX_WORKERS) poolWorker = spawnWorker();
    if (!poolWorker) return;
    assign(poolWorker, waiting.shift()!);
  }
}

export function parseWebPageInWorker(html: string, url: string): Promise<ParsedWebPage> {
  return new Promise((resolve, reject) => {
    waiting.push({
      requestId: crypto.randomUUID(),
      html,
      url,
      resolve,
      reject,
    });
    drain();
  });
}
