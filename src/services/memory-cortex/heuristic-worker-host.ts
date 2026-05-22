import { warnBunWorkerFallback, shouldUseBunWorkers } from "../../utils/bun-worker-guard";
import { runHeuristicAnalysis } from "./heuristic-analysis";
import type {
  HeuristicAnalysisInput,
  HeuristicAnalysisOutput,
  HeuristicWorkerRequest,
  HeuristicWorkerResponse,
} from "./heuristic-runtime";

interface PendingRequest {
  resolve: (value: HeuristicAnalysisOutput) => void;
  reject: (reason?: unknown) => void;
}

class HeuristicWorkerHost {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./heuristic-worker.ts", import.meta.url).href, {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<HeuristicWorkerResponse>) => {
      const msg = event.data;
      if (!msg) return;
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      this.pending.delete(msg.requestId);

      if (msg.type === "result") pending.resolve(msg.result);
      else pending.reject(new Error(msg.error));
    };

    worker.onerror = (event) => {
      const error = event instanceof ErrorEvent
        ? event.error ?? new Error(event.message)
        : new Error("Heuristic worker crashed");
      this.failAll(error);
      this.worker = null;
      try { worker.terminate(); } catch { /* noop */ }
    };

    this.worker = worker;
    return worker;
  }

  private failAll(error: unknown): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  run(payload: HeuristicAnalysisInput): Promise<HeuristicAnalysisOutput> {
    if (!shouldUseBunWorkers()) {
      warnBunWorkerFallback("memory-cortex heuristics");
      return Promise.resolve(runHeuristicAnalysis(payload));
    }

    const requestId = crypto.randomUUID();
    const worker = this.ensureWorker();
    const request: HeuristicWorkerRequest = { type: "run", requestId, payload };

    return new Promise<HeuristicAnalysisOutput>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage(request);
    });
  }
}

/**
 * Round-robin pool of heuristic worker hosts.
 *
 * The previous implementation used a single shared worker. For workloads that
 * fire concurrent heuristic requests (notably arbiter-mode rebuilds, where
 * Promise.all queues 5+ chunks per batch and ~3 batches run concurrently),
 * everything serialized inside that one worker — turning N parallel requests
 * into N sequential ones.
 *
 * Each pool host owns its own worker, created lazily on first use. Hosts that
 * are never used cost nothing. Round-robin distribution keeps utilization even
 * without needing a real work-stealing queue.
 */
const HEURISTIC_WORKER_POOL_SIZE = 4;

class HeuristicWorkerPool {
  private hosts: HeuristicWorkerHost[];
  private nextIdx = 0;

  constructor(size: number) {
    const count = Math.max(1, Math.floor(size));
    this.hosts = Array.from({ length: count }, () => new HeuristicWorkerHost());
  }

  run(payload: HeuristicAnalysisInput): Promise<HeuristicAnalysisOutput> {
    const host = this.hosts[this.nextIdx];
    this.nextIdx = (this.nextIdx + 1) % this.hosts.length;
    return host.run(payload);
  }
}

const pool = new HeuristicWorkerPool(HEURISTIC_WORKER_POOL_SIZE);

export function runHeuristicAnalysisInWorker(payload: HeuristicAnalysisInput): Promise<HeuristicAnalysisOutput> {
  return pool.run(payload);
}
