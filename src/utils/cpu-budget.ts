import { availableParallelism } from "node:os";

export interface WorkerBudget {
  logicalThreads: number;
  reserved: number;
  /** JS-side parse/read/write workers. */
  workerConcurrency: number;
  /** libvips / Sharp thread pool size. */
  sharpConcurrency: number;
  /** Concurrent deferred thumbnail jobs. */
  deferredImageConcurrency: number;
}

let budgetOverride: WorkerBudget | null = null;

export function logicalThreadCount(
  available: () => number = availableParallelism,
): number {
  try {
    const n = available();
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  } catch {
    return 1;
  }
}

/**
 * Leave a growing OS reserve (~12.5%, floor 2) so chat/generation still have
 * cores. Laptop numbers stay conservative; big hosts get more Sharp/import
 * workers instead of the old hard 4-thread cap.
 */
export function deriveWorkerBudget(
  logicalThreads: number = logicalThreadCount(),
  reserved?: number,
): WorkerBudget {
  const threads = Math.max(1, Math.floor(logicalThreads));
  const defaultReserved = Math.max(2, Math.floor(threads / 8));
  const reserve = Math.max(0, Math.min(reserved ?? defaultReserved, Math.max(0, threads - 1)));
  const usable = Math.max(1, threads - reserve);
  const laptopWorkers = Math.min(6, usable);
  const hostWorkers = Math.floor(usable / 4);
  const deferredJobs = usable < 4
    ? 1
    : Math.max(2, Math.ceil(usable / 8));
  return {
    logicalThreads: threads,
    reserved: reserve,
    workerConcurrency: Math.max(1, Math.min(16, Math.max(laptopWorkers, hostWorkers))),
    sharpConcurrency: Math.max(1, Math.min(24, Math.max(Math.min(4, usable), Math.floor(usable / 3)))),
    deferredImageConcurrency: Math.max(1, Math.min(8, deferredJobs)),
  };
}

export function currentWorkerBudget(): WorkerBudget {
  return budgetOverride ?? deriveWorkerBudget();
}

export function setWorkerBudgetOverride(budget: WorkerBudget | null): void {
  budgetOverride = budget;
}
