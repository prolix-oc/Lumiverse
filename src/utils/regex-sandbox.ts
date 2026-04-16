/**
 * Worker-backed regex sandbox.
 *
 * User-supplied patterns (regex scripts, the {{regex}} macro, the
 * {{regexInstalled}} macro, the test-regex API) used to run on the main event
 * loop, where catastrophic backtracking like `(a+)+$` would freeze the entire
 * server until the process was killed. This module evaluates those patterns
 * inside a Bun Worker pool with a hard wall-clock timeout. When the timeout
 * fires we kill the worker, reject the in-flight request, and respawn — the
 * main thread stays responsive.
 *
 * The pool is small (default 2 workers) because regex evaluation is normally
 * fast: the primary cost we're paying is the postMessage round-trip, not
 * concurrency. A second worker exists so that one runaway regex doesn't
 * stall every other regex in the same generation.
 */

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_POOL_SIZE = 2;

export class RegexTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Regex evaluation exceeded ${timeoutMs}ms and was aborted`);
    this.name = "RegexTimeoutError";
  }
}

export class RegexSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexSandboxError";
  }
}

export interface SandboxMatch {
  fullMatch: string;
  index: number;
  groups: (string | undefined)[];
  namedGroups?: Record<string, string>;
}

interface QueueItem {
  op: "replace" | "test" | "collect";
  payload: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface InFlight {
  id: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutMs: number;
}

class RegexWorkerPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private inflight = new Map<Worker, InFlight>();
  private queue: QueueItem[] = [];

  constructor(private readonly maxSize: number) {}

  run<T>(op: QueueItem["op"], payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        op,
        payload,
        timeoutMs,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      const worker = this.acquire();
      if (worker) {
        this.dispatch(worker, item);
      } else {
        this.queue.push(item);
      }
    });
  }

  private acquire(): Worker | null {
    const idle = this.idle.pop();
    if (idle) return idle;
    if (this.workers.size < this.maxSize) {
      return this.spawn();
    }
    return null;
  }

  private spawn(): Worker {
    const worker = new Worker(
      new URL("./regex-sandbox.worker.ts", import.meta.url).href,
      { type: "module" },
    );
    worker.addEventListener("message", (e) => this.onMessage(worker, e as MessageEvent));
    worker.addEventListener("error", (e) => this.onError(worker, e as ErrorEvent));
    this.workers.add(worker);
    return worker;
  }

  private dispatch(worker: Worker, item: QueueItem): void {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => this.onTimeout(worker), item.timeoutMs);
    this.inflight.set(worker, {
      id,
      timer,
      resolve: item.resolve,
      reject: item.reject,
      timeoutMs: item.timeoutMs,
    });
    worker.postMessage({ id, op: item.op, ...item.payload });
  }

  private onMessage(worker: Worker, event: MessageEvent): void {
    const data = event.data as { id: string; ok: boolean; result?: unknown; error?: string };
    const flight = this.inflight.get(worker);
    if (!flight || flight.id !== data.id) return; // stale; ignore
    this.inflight.delete(worker);
    clearTimeout(flight.timer);
    if (data.ok) flight.resolve(data.result);
    else flight.reject(new RegexSandboxError(data.error || "Regex evaluation failed"));
    this.release(worker);
  }

  private onError(worker: Worker, event: ErrorEvent): void {
    const flight = this.inflight.get(worker);
    if (flight) {
      this.inflight.delete(worker);
      clearTimeout(flight.timer);
      flight.reject(new RegexSandboxError(`Regex worker crashed: ${event.message || "unknown"}`));
    }
    this.discard(worker);
  }

  private onTimeout(worker: Worker): void {
    const flight = this.inflight.get(worker);
    if (flight) {
      this.inflight.delete(worker);
      flight.reject(new RegexTimeoutError(flight.timeoutMs));
    }
    try { worker.terminate(); } catch { /* ignore */ }
    this.discard(worker);
    this.drainQueue();
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) this.dispatch(worker, next);
    else this.idle.push(worker);
  }

  private discard(worker: Worker): void {
    this.workers.delete(worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const worker = this.acquire();
      if (!worker) break;
      const item = this.queue.shift();
      if (!item) {
        this.idle.push(worker);
        break;
      }
      this.dispatch(worker, item);
    }
  }

  /** Tear down the pool — call from shutdown hooks. */
  shutdown(): void {
    for (const w of this.workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    this.workers.clear();
    this.idle = [];
    for (const flight of this.inflight.values()) {
      clearTimeout(flight.timer);
      flight.reject(new RegexSandboxError("Regex sandbox shut down"));
    }
    this.inflight.clear();
    for (const item of this.queue) {
      item.reject(new RegexSandboxError("Regex sandbox shut down"));
    }
    this.queue = [];
  }
}

let _pool: RegexWorkerPool | null = null;

function getPool(): RegexWorkerPool {
  if (!_pool) _pool = new RegexWorkerPool(DEFAULT_POOL_SIZE);
  return _pool;
}

export function shutdownRegexSandbox(): void {
  if (_pool) {
    _pool.shutdown();
    _pool = null;
  }
}

/** Validate the pattern compiles before sending to a worker. */
function assertCompilable(pattern: string, flags: string): void {
  // A syntactically invalid pattern doesn't risk ReDoS — fail synchronously
  // so callers don't pay the worker round-trip just to get a SyntaxError.
  // eslint-disable-next-line no-new
  new RegExp(pattern, flags);
}

export async function regexReplaceSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  assertCompilable(pattern, flags);
  return getPool().run<string>(
    "replace",
    { pattern, flags, input, replacement },
    timeoutMs,
  );
}

export async function regexCollectSandboxed(
  pattern: string,
  flags: string,
  input: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SandboxMatch[]> {
  assertCompilable(pattern, flags);
  return getPool().run<SandboxMatch[]>(
    "collect",
    { pattern, flags, input },
    timeoutMs,
  );
}

export async function regexTestSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ result: string; matches: number }> {
  assertCompilable(pattern, flags);
  return getPool().run<{ result: string; matches: number }>(
    "test",
    { pattern, flags, input, replacement },
    timeoutMs,
  );
}
