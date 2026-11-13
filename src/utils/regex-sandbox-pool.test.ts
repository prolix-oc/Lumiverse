import { describe, expect, test } from "bun:test";
import {
  RegexTimeoutError,
  RegexSandboxShutdownError,
  RegexWorkerPool,
  RegexWorkerStartupTimeoutError,
  type RegexWorkerPoolDeps,
} from "./regex-sandbox";

interface ManualTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

class FakeWorker {
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private errorHandler: ((event: ErrorEvent) => void) | null = null;

  addEventListener(type: "message" | "error", handler: (event: never) => void): void {
    if (type === "message") {
      this.messageHandler = handler as unknown as (event: MessageEvent) => void;
    } else {
      this.errorHandler = handler as unknown as (event: ErrorEvent) => void;
    }
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: Record<string, unknown>): void {
    this.messageHandler?.({ data } as MessageEvent);
  }
}

function createHarness() {
  const workers: FakeWorker[] = [];
  const timers: ManualTimer[] = [];
  let nextId = 0;
  const deps: RegexWorkerPoolDeps = {
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    scheduleTimer: (fn, ms) => {
      const timer: ManualTimer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelTimer: (value) => {
      (value as ManualTimer).cancelled = true;
    },
    createRequestId: () => `request-${++nextId}`,
    startupTimeoutMs: 5_000,
  };
  return {
    pool: new RegexWorkerPool(1, deps),
    workers,
    timers,
    fire(timer: ManualTimer): void {
      if (!timer.cancelled) timer.fn();
    },
  };
}

describe("regex worker timing attribution", () => {
  test("shutdown rejects active and queued work with an expected cancellation", async () => {
    const harness = createHarness();
    const active = harness.pool.run<boolean>("test", { pattern: "x" }, 7);
    const queued = harness.pool.run<boolean>("test", { pattern: "y" }, 7);
    const activeResult = active.catch((caught) => caught);
    const queuedResult = queued.catch((caught) => caught);

    harness.pool.shutdown();

    expect(await activeResult).toBeInstanceOf(RegexSandboxShutdownError);
    expect(await queuedResult).toBeInstanceOf(RegexSandboxShutdownError);
    expect(harness.workers[0]?.terminated).toBe(true);
  });

  test("a worker startup timeout is not reported as a regex timeout", async () => {
    const harness = createHarness();
    const pending = harness.pool.run<boolean>("test", { pattern: "x" }, 7);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.ms).toBe(5_000);
    harness.fire(harness.timers[0]!);

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(RegexWorkerStartupTimeoutError);
    expect(error).not.toBeInstanceOf(RegexTimeoutError);
    expect(harness.workers[0]?.terminated).toBe(true);
  });

  test("the regex deadline starts only after the worker acknowledges the request", async () => {
    const harness = createHarness();
    const pending = harness.pool.run<boolean>("test", { pattern: "x" }, 7);
    const worker = harness.workers[0]!;
    const id = worker.posted[0]?.id as string;

    worker.emitMessage({ id, type: "started" });

    expect(harness.timers[0]?.cancelled).toBe(true);
    expect(harness.timers[1]?.ms).toBe(7);
    harness.fire(harness.timers[1]!);
    await expect(pending).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(worker.terminated).toBe(true);
  });

  test("a delayed acknowledgement does not consume the regex execution budget", async () => {
    const harness = createHarness();
    const pending = harness.pool.run<string>("replace", { pattern: "x" }, 11);
    const worker = harness.workers[0]!;
    const id = worker.posted[0]?.id as string;

    worker.emitMessage({ id, type: "started" });
    worker.emitMessage({ id, ok: true, result: "done" });

    await expect(pending).resolves.toBe("done");
    expect(harness.timers.map(({ ms }) => ms)).toEqual([5_000, 11]);
    expect(harness.timers.every(({ cancelled }) => cancelled)).toBe(true);
    harness.pool.shutdown();
  });
});
