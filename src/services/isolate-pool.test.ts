import { beforeEach, describe, expect, test } from "bun:test";
import {
  getIsolateHealthSnapshot,
  IsolatePoolError,
  IsolatePoolV1,
  probeIsolateBackendsAtStartup,
  resetIsolateHealthForTests,
  type IsolateBackendKind,
  type IsolateTransport,
} from "./isolate-pool";
import { decodeLengthPrefixedJson, encodeLengthPrefixedJson } from "./isolate-protocol";

class FakeTransport implements IsolateTransport {
  readonly kind: IsolateBackendKind;
  readonly sent: unknown[] = [];
  private messageHandler: ((message: unknown) => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;
  private terminated = false;
  private readonly firstSend = Promise.withResolvers<void>();

  constructor(
    kind: IsolateBackendKind = "worker",
    private readonly deferTermination = false,
  ) {
    this.kind = kind;
  }

  send(message: unknown): void {
    if (this.terminated) throw new Error("transport terminated");
    this.sent.push(message);
    this.firstSend.resolve();
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }

  onError(handler: (error: unknown) => void): () => void {
    this.errorHandler = handler;
    return () => {
      if (this.errorHandler === handler) this.errorHandler = null;
    };
  }

  terminate(): void | Promise<void> {
    if (!this.deferTermination) {
      this.terminated = true;
      return;
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        this.terminated = true;
        resolve();
      }, 0);
    });
  }

  respond(message: unknown): void {
    this.messageHandler?.(message);
  }

  respondFrame(message: unknown, maxFrameBytes: number): void {
    try {
      this.respond(decodeLengthPrefixedJson(encodeLengthPrefixedJson(message, maxFrameBytes), maxFrameBytes));
    } catch (error) {
      this.errorHandler?.(error);
    }
  }

  crash(error: Error): void {
    this.errorHandler?.(error);
  }

  isTerminated(): boolean {
    return this.terminated;
  }
  waitForSend(): Promise<void> {
    return this.firstSend.promise;
  }
}

function response(request: unknown, result: unknown): unknown {
  const requestId = request instanceof Uint8Array
    ? String(decodeLengthPrefixedJson<{ requestId?: unknown }>(request).requestId ?? "")
    : typeof request === "object" && request !== null && "requestId" in request
      ? String(request.requestId)
      : "";
  return { version: 1, type: "result", requestId, result };
}

beforeEach(() => {
  resetIsolateHealthForTests();
});

async function waitFor(predicate: () => boolean, attempts = 12): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
    await Promise.resolve();
  }
}



describe("IsolatePoolV1", () => {
  test("does not mark Worker healthy when probe termination rejects", async () => {
    const originalWorker = globalThis.Worker;
    class RejectingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor() {
        queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent));
      }

      terminate(): Promise<void> {
        return Promise.reject(new Error("worker termination denied"));
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: RejectingWorker,
    });
    try {
      const health = await probeIsolateBackendsAtStartup();
      expect(health.worker).toBe("unavailable");
      expect(health.workerReason).toMatch(/termination denied/);
    } finally {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: originalWorker,
      });
    }
  });
  test("fairly rotates users while preserving per-user order", async () => {
    const transports: FakeTransport[] = [];
    const pool = new IsolatePoolV1<{ value: string }, string>({
      name: "test",
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });

    const first = pool.submit({ userId: "a", operation: "test", payload: { value: "a1" } });
    const second = pool.submit({ userId: "a", operation: "test", payload: { value: "a2" } });
    const other = pool.submit({ userId: "b", operation: "test", payload: { value: "b1" } });
    await Promise.resolve();
    transports[0].respond(response(transports[0].sent[0], "a1"));
    expect(await first).toBe("a1");
    await Promise.resolve();
    transports[0].respond(response(transports[0].sent.at(-1), "b1"));
    expect(await other).toBe("b1");
    await Promise.resolve();
    transports[0].respond(response(transports[0].sent.at(-1), "a2"));
    expect(await second).toBe("a2");
    await pool.shutdown();
  });

  test("releases idle transports without interrupting active work", async () => {
    const transports: FakeTransport[] = [];
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });

    const active = pool.submit({ userId: "u", operation: "test", payload: { value: "active" } });
    await waitFor(() => transports[0]?.sent.length === 1);
    expect(pool.releaseIdle()).toBe(0);
    transports[0]!.respond(response(transports[0]!.sent[0], "active"));
    expect(await active).toBe("active");

    expect(pool.releaseIdle()).toBe(1);
    await waitFor(() => transports[0]!.isTerminated());
    expect(transports[0]!.isTerminated()).toBe(true);

    const next = pool.submit({ userId: "u", operation: "test", payload: { value: "next" } });
    await waitFor(() => transports[1]?.sent.length === 1);
    transports[1]!.respond(response(transports[1]!.sent[0], "next"));
    expect(await next).toBe("next");
    await pool.shutdown();
  });

  test("enforces per-user queued admission and global queue caps", async () => {
    const transport = new FakeTransport();
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      maxQueuedPerUser: 2,
      maxQueuedGlobal: 3,
      workerFactory: () => transport,
    });
    const active = pool.submit({ userId: "u", operation: "test", payload: { value: "active" } });
    const queued1 = pool.submit({ userId: "u", operation: "test", payload: { value: "queued1" } });
    const queued2 = pool.submit({ userId: "u", operation: "test", payload: { value: "queued2" } });
    await expect(pool.submit({ userId: "u", operation: "test", payload: { value: "overflow" } })).rejects.toMatchObject({ code: "queue_full" });
    transport.respond(response(transport.sent[0], "active"));
    await active;
    await pool.shutdown();
    await expect(queued1).rejects.toBeInstanceOf(IsolatePoolError);
    await expect(queued2).rejects.toBeInstanceOf(IsolatePoolError);
  });

  test("maps timeout, cancellation, crash, and malformed responses to stable failures", async () => {
    const transports: FakeTransport[] = [];
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      defaultTimeoutMs: 50,
    });
    const timedOut = pool.submit({ userId: "u", operation: "test", payload: { value: "timeout" }, timeoutMs: 5 });
    await expect(timedOut).rejects.toMatchObject({ code: "worker_timed_out" });
    const controller = new AbortController();
    const cancelled = pool.submit({ userId: "u", operation: "test", payload: { value: "cancel" }, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });

    const transportsBeforeCrash = new Set(transports);
    const crashed = pool.submit({ userId: "u", operation: "test", payload: { value: "crash" } });
    await waitFor(() => transports.some((transport) => !transportsBeforeCrash.has(transport) && transport.sent.length > 0));
    const crashedTransport = transports.find(
      (transport) => !transportsBeforeCrash.has(transport) && transport.sent.length > 0,
    );
    crashedTransport?.crash(new Error("boom"));
    await expect(crashed).rejects.toMatchObject({ code: "worker_crashed" });

    const transportsBeforeMalformed = new Set(transports);
    const malformed = pool.submit({ userId: "u", operation: "test", payload: { value: "malformed" } });
    await waitFor(() => transports.some((transport) => !transportsBeforeMalformed.has(transport) && transport.sent.length > 0));
    const malformedTransport = transports.find(
      (transport) => !transportsBeforeMalformed.has(transport) && transport.sent.length > 0,
    );
    malformedTransport?.respond({ invalid: true });
    await expect(malformed).rejects.toMatchObject({ code: "worker_malformed" });
    await pool.shutdown();
  });
  test("fails over a crashed Worker job once to a healthy subprocess", async () => {
    const workerHealthTransport = new FakeTransport("worker");
    const workerHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => workerHealthTransport,
    });
    const workerHealthJob = workerHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "worker" },
    });
    await waitFor(() => workerHealthTransport.sent.length > 0);
    workerHealthTransport.respond(response(workerHealthTransport.sent[0], "worker"));
    await workerHealthJob;
    await workerHealthPool.shutdown();

    const subprocessHealthTransport = new FakeTransport("subprocess");
    const subprocessHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      subprocessFactory: () => subprocessHealthTransport,
    });
    const subprocessHealthJob = subprocessHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "subprocess" },
    });
    await waitFor(() => subprocessHealthTransport.sent.length > 0);
    subprocessHealthTransport.respond(response(subprocessHealthTransport.sent[0], "subprocess"));
    await subprocessHealthJob;
    await subprocessHealthPool.shutdown();

    const workers: FakeTransport[] = [];
    const subprocesses: FakeTransport[] = [];
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "auto",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        workers.push(transport);
        return transport;
      },
      subprocessFactory: () => {
        const transport = new FakeTransport("subprocess");
        subprocesses.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });

    const failedOver = pool.submit({ userId: "u", operation: "test", payload: { value: "failover" } });
    await waitFor(() => (workers[0]?.sent.length ?? 0) > 0);
    workers[0]!.crash(new Error("boom"));
    await waitFor(() => (subprocesses[0]?.sent.length ?? 0) > 0);
    expect(workers).toHaveLength(1);
    expect(subprocesses).toHaveLength(1);
    subprocesses[0]!.respond(response(subprocesses[0]!.sent.at(-1), "fallback"));
    expect(await failedOver).toBe("fallback");
    await pool.shutdown();
  });
  test("carries one absolute wall deadline across Worker failover", async () => {
    const workerHealthTransport = new FakeTransport("worker");
    const workerHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => workerHealthTransport,
    });
    const workerHealthJob = workerHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "worker" },
    });
    await waitFor(() => workerHealthTransport.sent.length > 0);
    workerHealthTransport.respond(response(workerHealthTransport.sent[0], "worker"));
    await workerHealthJob;
    await workerHealthPool.shutdown();

    const subprocessHealthTransport = new FakeTransport("subprocess");
    const subprocessHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      subprocessFactory: () => subprocessHealthTransport,
    });
    const subprocessHealthJob = subprocessHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "subprocess" },
    });
    await waitFor(() => subprocessHealthTransport.sent.length > 0);
    subprocessHealthTransport.respond(response(subprocessHealthTransport.sent[0], "subprocess"));
    await subprocessHealthJob;
    await subprocessHealthPool.shutdown();

    const workers: FakeTransport[] = [];
    const subprocesses: FakeTransport[] = [];
    let workerDeadlineAt: number | null = null;
    let subprocessDeadlineAt: number | null = null;
    const request = (job: {
      requestId: string;
      operation: string;
      payload: { value: string };
      deadlineAt: number;
    }) => ({
      version: 1,
      type: "request",
      requestId: job.requestId,
      operation: job.operation,
      payload: job.payload,
    });
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "auto",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        workers.push(transport);
        return transport;
      },
      subprocessFactory: () => {
        const transport = new FakeTransport("subprocess");
        subprocesses.push(transport);
        return transport;
      },
      workerRequest: (job) => {
        workerDeadlineAt = job.deadlineAt;
        return request(job);
      },
      subprocessRequest: (job) => {
        subprocessDeadlineAt = job.deadlineAt;
        return request(job);
      },
      transportProbe: async () => {},
    });

    const failedOver = pool.submit({
      userId: "u",
      operation: "test",
      payload: { value: "deadline" },
      timeoutMs: 100,
    });
    await waitFor(() => (workers[0]?.sent.length ?? 0) > 0);
    workers[0]!.crash(new Error("worker crash"));
    await waitFor(() => (subprocesses[0]?.sent.length ?? 0) > 0, 64);

    expect(workerDeadlineAt).not.toBeNull();
    expect(subprocessDeadlineAt).toBe(workerDeadlineAt);
    subprocesses[0]!.respond(response(subprocesses[0]!.sent.at(-1), "fallback"));
    expect(await failedOver).toBe("fallback");
    await pool.shutdown();
  });
  test("does not reuse an idle Worker slot after a sibling Worker crashes", async () => {
    const workerHealthTransport = new FakeTransport("worker");
    const workerHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => workerHealthTransport,
    });
    const workerHealthJob = workerHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "worker" },
    });
    await waitFor(() => workerHealthTransport.sent.length > 0);
    workerHealthTransport.respond(response(workerHealthTransport.sent[0], "worker"));
    await workerHealthJob;
    await workerHealthPool.shutdown();

    const subprocessHealthTransport = new FakeTransport("subprocess");
    const subprocessHealthPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      subprocessFactory: () => subprocessHealthTransport,
    });
    const subprocessHealthJob = subprocessHealthPool.submit({
      userId: "health",
      operation: "probe",
      payload: { value: "subprocess" },
    });
    await waitFor(() => subprocessHealthTransport.sent.length > 0);
    subprocessHealthTransport.respond(response(subprocessHealthTransport.sent[0], "subprocess"));
    await subprocessHealthJob;
    await subprocessHealthPool.shutdown();

    const workers: FakeTransport[] = [];
    const subprocesses: FakeTransport[] = [];
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "auto",
      maxWorkers: 2,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        workers.push(transport);
        return transport;
      },
      subprocessFactory: () => {

        const transport = new FakeTransport("subprocess");
        subprocesses.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });

    const first = pool.submit({ userId: "u", operation: "test", payload: { value: "first" } });
    const crashed = pool.submit({ userId: "u", operation: "test", payload: { value: "crashed" } });
    await waitFor(() => workers.length === 2 && workers.every((transport) => transport.sent.length > 0));
    workers[0]!.respond(response(workers[0]!.sent[0], "first"));
    expect(await first).toBe("first");

    workers[1]!.crash(new Error("boom"));
    await waitFor(() =>
      workers[0]!.sent.length > 1
      || subprocesses.some((transport) => transport.sent.length > 0),
    );
    if (workers[0]!.sent.length > 1) {
      workers[0]!.respond(response(workers[0]!.sent.at(-1), "wrong-worker"));
    }
    for (const transport of subprocesses) {
      for (const request of transport.sent) {
        transport.respond(response(request, "fallback"));
      }
    }
    expect(await crashed).toBe("fallback");
    expect(workers[0]!.sent).toHaveLength(1);
    expect(workers[1]!.sent).toHaveLength(1);
    await pool.shutdown();
  });
  test("keeps an active Worker failure visible after an unrelated subprocess health update", async () => {
    const workers: FakeTransport[] = [];
    const workerPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        workers.push(transport);
        return transport;
      },
      transportProbe: async () => {
        if (workers.length > 1) throw new Error("Worker replacement refused");
      },
    });
    const active = workerPool.submit({ userId: "worker", operation: "test", payload: { value: "active" } });
    await waitFor(() => workers[0]?.sent.length === 1);

    const subprocesses: FakeTransport[] = [];
    const subprocessPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      subprocessFactory: () => {
        const transport = new FakeTransport("subprocess");
        subprocesses.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const subprocessJob = subprocessPool.submit({
      userId: "subprocess",
      operation: "test",
      payload: { value: "health" },
    });
    await waitFor(() => subprocesses[0]?.sent.length === 1);
    subprocesses[0]!.respond(response(subprocesses[0]!.sent[0], "health"));
    expect(await subprocessJob).toBe("health");

    workers[0]!.crash(new Error("active Worker crash"));
    await expect(active).rejects.toMatchObject({ code: "worker_crashed" });
    await waitFor(() => getIsolateHealthSnapshot().worker === "unavailable");
    expect(getIsolateHealthSnapshot().worker).toBe("unavailable");

    await workerPool.shutdown();
    await subprocessPool.shutdown();
  });

  test("does not let an old Worker slot override health after reprobe recovery", async () => {
    const oldWorkers: FakeTransport[] = [];
    const oldPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        oldWorkers.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const oldJob = oldPool.submit({ userId: "old", operation: "test", payload: { value: "old" } });
    await waitFor(() => oldWorkers[0]?.sent.length === 1);

    const recoveringWorkers: FakeTransport[] = [];
    const recoveringPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        recoveringWorkers.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const crashedJob = recoveringPool.submit({
      userId: "recovering",
      operation: "test",
      payload: { value: "crashed" },
    });
    await waitFor(() => recoveringWorkers[0]?.sent.length === 1);
    recoveringWorkers[0]!.crash(new Error("Worker reprobe trigger"));
    await expect(crashedJob).rejects.toMatchObject({ code: "worker_crashed" });
    await waitFor(
      () => recoveringWorkers.length === 2 && getIsolateHealthSnapshot().worker === "healthy",
      64,
    );
    expect(getIsolateHealthSnapshot().worker).toBe("healthy");

    oldWorkers[0]!.crash(new Error("late old Worker crash"));
    await expect(oldJob).rejects.toMatchObject({ code: "worker_unavailable" });
    await Promise.resolve();
    expect(getIsolateHealthSnapshot().worker).toBe("healthy");

    await oldPool.shutdown();
    await recoveringPool.shutdown();
  });

  test("retires a stale idle slot without starving asynchronous replacement", async () => {
    const firstPoolTransports: FakeTransport[] = [];
    const firstPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker", true);
        firstPoolTransports.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const firstJob = firstPool.submit({ userId: "first", operation: "test", payload: { value: "first" } });
    await waitFor(() => firstPoolTransports[0]?.sent.length === 1);
    firstPoolTransports[0]!.respond(response(firstPoolTransports[0]!.sent[0], "first"));
    expect(await firstJob).toBe("first");

    const secondPoolTransports: FakeTransport[] = [];
    const secondPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        secondPoolTransports.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const failedJob = secondPool.submit({ userId: "second", operation: "test", payload: { value: "crash" } });
    await waitFor(() => secondPoolTransports[0]?.sent.length === 1);
    secondPoolTransports[0]!.crash(new Error("sibling crash"));
    await expect(failedJob).rejects.toMatchObject({ code: "worker_crashed" });
    await waitFor(
      () => secondPoolTransports.length === 2 && getIsolateHealthSnapshot().worker === "healthy",
      64,
    );

    const replacementJob = firstPool.submit({ userId: "first", operation: "test", payload: { value: "replacement" } });
    await waitFor(() => firstPoolTransports.length === 2 && firstPoolTransports[1]!.sent.length === 1, 64);
    setTimeout(() => {
      firstPoolTransports[1]!.respond(response(firstPoolTransports[1]!.sent[0], "replacement"));
    }, 0);
    expect(await replacementJob).toBe("replacement");
    expect(firstPoolTransports[0]!.isTerminated()).toBe(true);
    await firstPool.shutdown();
    await secondPool.shutdown();
  });


  test("replaces a timed-out Worker slot and keeps the backend healthy", async () => {
    const transports: FakeTransport[] = [];
    const replacementCreated = Promise.withResolvers<FakeTransport>();
    let probeCount = 0;
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      maxFrameBytes: 256,
      defaultTimeoutMs: 100,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        transports.push(transport);
        if (transports.length === 2) replacementCreated.resolve(transport);
        return transport;
      },
      transportProbe: async () => {
        probeCount++;
      },
    });
    const startingEpoch = getIsolateHealthSnapshot().epoch;
    const failed = pool.submit({ userId: "u", operation: "test", payload: { value: "timeout" }, timeoutMs: 1 });
    await expect(failed).rejects.toMatchObject({ code: "worker_timed_out" });
    const benign = pool.submit({ userId: "u", operation: "test", payload: { value: "ok" } });
    const replacement = await replacementCreated.promise;
    await replacement.waitForSend();
    const health = getIsolateHealthSnapshot();
    expect(transports).toHaveLength(2);
    expect(transports[0]?.isTerminated()).toBe(true);
    expect(health.worker).toBe("healthy");
    expect(health.epoch).toBeGreaterThan(startingEpoch);
    expect(probeCount).toBeGreaterThanOrEqual(2);
    replacement.respond(response(replacement.sent.at(-1), "ok"));
    expect(await benign).toBe("ok");
    await pool.shutdown();
  });

  test("replaces a timed-out subprocess slot without poisoning Worker health", async () => {
    const transports: FakeTransport[] = [];
    const replacementCreated = Promise.withResolvers<FakeTransport>();
    const pool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      maxFrameBytes: 256,
      defaultTimeoutMs: 100,
      subprocessFactory: () => {
        const transport = new FakeTransport("subprocess");
        transports.push(transport);
        if (transports.length === 2) replacementCreated.resolve(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const failed = pool.submit({ userId: "u", operation: "test", payload: { value: "timeout" }, timeoutMs: 1 });
    await expect(failed).rejects.toMatchObject({ code: "worker_timed_out" });
    const benign = pool.submit({ userId: "u", operation: "test", payload: { value: "ok" } });
    const replacement = await replacementCreated.promise;
    await replacement.waitForSend();
    const health = getIsolateHealthSnapshot();
    expect(transports).toHaveLength(2);
    expect(health.subprocess).toBe("healthy");
    expect(health.worker).toBe("unknown");
    replacement.respond(response(replacement.sent.at(-1), "ok"));
    expect(await benign).toBe("ok");
    await pool.shutdown();
  });
  test("reprobes unavailable backends for a later pool without resetting global health", async () => {
    const failedWorkers: FakeTransport[] = [];
    let workerFactoryCalls = 0;
    const workerFailurePool = new IsolatePoolV1<{ value: string }, string>({
      backend: "worker",
      maxWorkers: 1,
      workerFactory: () => {
        workerFactoryCalls++;
        if (workerFactoryCalls > 1) throw new Error("worker replacement unavailable");
        const transport = new FakeTransport("worker");
        failedWorkers.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const failedWorkerJob = workerFailurePool.submit({
      userId: "failure",
      operation: "test",
      payload: { value: "worker-failure" },
    });
    await waitFor(() => failedWorkers[0]?.sent.length === 1);
    failedWorkers[0]!.crash(new Error("worker boom"));
    await expect(failedWorkerJob).rejects.toMatchObject({ code: "worker_crashed" });
    await waitFor(() => getIsolateHealthSnapshot().worker === "unavailable");
    await workerFailurePool.shutdown();

    const failedSubprocesses: FakeTransport[] = [];
    let subprocessFactoryCalls = 0;
    const subprocessFailurePool = new IsolatePoolV1<{ value: string }, string>({
      backend: "subprocess",
      maxWorkers: 1,
      subprocessFactory: () => {
        subprocessFactoryCalls++;
        if (subprocessFactoryCalls > 1) throw new Error("subprocess replacement unavailable");
        const transport = new FakeTransport("subprocess");
        failedSubprocesses.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const failedSubprocessJob = subprocessFailurePool.submit({
      userId: "failure",
      operation: "test",
      payload: { value: "subprocess-failure" },
    });
    await waitFor(() => failedSubprocesses[0]?.sent.length === 1);
    failedSubprocesses[0]!.crash(new Error("subprocess boom"));
    await expect(failedSubprocessJob).rejects.toMatchObject({ code: "worker_crashed" });
    await waitFor(() => getIsolateHealthSnapshot().subprocess === "unavailable");
    expect(getIsolateHealthSnapshot().selected).toBe("unavailable");
    await subprocessFailurePool.shutdown();

    const recoveredWorkers: FakeTransport[] = [];
    const recoveredSubprocesses: FakeTransport[] = [];
    const recoveryPool = new IsolatePoolV1<{ value: string }, string>({
      backend: "auto",
      maxWorkers: 1,
      workerFactory: () => {
        const transport = new FakeTransport("worker");
        recoveredWorkers.push(transport);
        return transport;
      },
      subprocessFactory: () => {
        const transport = new FakeTransport("subprocess");
        recoveredSubprocesses.push(transport);
        return transport;
      },
      transportProbe: async () => {},
    });
    const recovered = recoveryPool.submit({
      userId: "recovered",
      operation: "test",
      payload: { value: "recovered" },
    });
    await waitFor(() => recoveredWorkers.some((transport) => transport.sent.length > 0), 64);
    const recoveredTransport = recoveredWorkers.find((transport) => transport.sent.length > 0);
    if (!recoveredTransport) throw new Error("recovery pool did not dispatch a Worker job");
    recoveredTransport.respond(response(recoveredTransport.sent[0], "recovered"));
    expect(await recovered).toBe("recovered");
    expect(getIsolateHealthSnapshot().selected).toBe("worker");
    expect(recoveredWorkers[0]?.isTerminated()).toBe(true);
    expect(recoveredSubprocesses[0]?.isTerminated()).toBe(true);
    await recoveryPool.shutdown();
  });


  test("keeps duplicated large request fields and oversized responses bounded for both transports", async () => {
    for (const kind of ["worker", "subprocess"] as const) {
      const transports: FakeTransport[] = [];
      const pool = new IsolatePoolV1<{ plan: string; duplicatePlan: string }, string>({
        backend: kind,
        maxWorkers: 1,
        maxFrameBytes: 256,
        workerFactory: kind === "worker"
          ? () => {
              const transport = new FakeTransport(kind);
              transports.push(transport);
              return transport;
            }
          : undefined,
        subprocessFactory: kind === "subprocess"
          ? () => {
              const transport = new FakeTransport(kind);
              transports.push(transport);
              return transport;
            }
          : undefined,
      });
      const oversizedRequest = pool.submit({
        userId: "u",
        operation: "test",
        payload: { plan: "x".repeat(160), duplicatePlan: "x".repeat(160) },
      });
      await expect(oversizedRequest).rejects.toMatchObject({ code: "limit_exceeded" });
      expect(transports[0]?.sent).toHaveLength(0);

      const oversizedResponse = pool.submit({
        userId: "u",
        operation: "test",
        payload: { plan: "small", duplicatePlan: "small" },
      });
      await waitFor(() => (transports.at(-1)?.sent.length ?? 0) > 0);
      const transport = transports.at(-1)!;
      const requestFrame = transport.sent.at(-1);
      if (!(requestFrame instanceof Uint8Array)) throw new Error("expected a framed request");
      transport.respondFrame({
        version: 1,
        type: "result",
        requestId: String(decodeLengthPrefixedJson<{ requestId: string }>(requestFrame).requestId),
        result: "x".repeat(400),
      }, 256);
      await expect(oversizedResponse).rejects.toMatchObject({ code: "limit_exceeded" });
      await pool.shutdown();
    }
  });
});
