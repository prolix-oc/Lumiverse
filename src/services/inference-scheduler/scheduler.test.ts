import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./config";
import { withLeaseAbort } from "./signals";
import {
  __test__,
  acquireInferenceLease,
  getInferenceSchedulerStatus,
  withInferenceLease,
  withInferenceLeaseStream,
} from "./scheduler";
import {
  InferenceQueueTimeoutError,
  type InferenceSchedulerConfig,
} from "./types";

const ENDPOINT_A = "http://127.0.0.1:5001/v1/chat/completions";
const ENDPOINT_B = "http://127.0.0.1:8080/v1/embeddings";

function config(overrides: Partial<InferenceSchedulerConfig> = {}): InferenceSchedulerConfig {
  return {
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  __test__.setHost(true);
  __test__.setConfig(config());
});

afterEach(() => {
  __test__.reset();
});

describe("inference scheduler serialization", () => {
  test("runs one request at a time on a shared local resource", async () => {
    const order: string[] = [];
    const gate = deferred();

    const first = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk", purpose: "first" },
      async () => {
        order.push("first:start");
        await gate.promise;
        order.push("first:end");
      },
    );
    await flush();

    const second = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_B, requestClass: "interactive", purpose: "second" },
      async () => {
        order.push("second");
      },
    );
    await flush();

    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("keeps separate queues when the unified pool is disabled", async () => {
    __test__.setConfig(config({ unifiedLocalPool: false }));
    const gate = deferred();
    const order: string[] = [];

    const first = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        order.push("a:start");
        await gate.promise;
      },
    );
    await flush();

    await withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_B, requestClass: "interactive" },
      async () => {
        order.push("b:ran");
      },
    );
    expect(order).toContain("b:ran");

    gate.resolve();
    await first;
  });

  test("does not schedule remote endpoints, disabled configs, or nested calls", async () => {
    const remote = await acquireInferenceLease({
      userId: "user-a",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });
    expect(remote.lease.scheduled).toBe(false);
    remote.lease.release();

    __test__.setConfig(config({ enabled: false }));
    const disabled = await acquireInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A });
    expect(disabled.lease.scheduled).toBe(false);
    disabled.lease.release();

    __test__.setConfig(config());
    await withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async (outer) => {
      expect(outer.scheduled).toBe(true);
      await withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async (inner) => {
        expect(inner.scheduled).toBe(false);
      });
    });
  });
});

describe("inference scheduler priority and preemption", () => {
  test("nested work inherits the outer lease's cancellation", async () => {
    const nested = deferred();
    const finish = deferred();
    let nestedSignal: AbortSignal | undefined;
    const background = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background" },
      async () => withInferenceLease(
        { userId: "user-a", endpoint: ENDPOINT_B },
        async (lease) => {
          nestedSignal = withLeaseAbort(new AbortController().signal, lease);
          nested.resolve();
          await finish.promise;
        },
      ),
    );
    await nested.promise;
    const interactive = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async () => {},
    );
    await flush();
    const aborted = nestedSignal?.aborted;
    finish.resolve();
    await Promise.all([background, interactive]);
    expect(aborted).toBe(true);
  });

  test("async work cannot reuse an outer lease after it has been released", async () => {
    const runLater = deferred();
    let later!: Promise<boolean>;
    await withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async () => {
      later = (async () => {
        await runLater.promise;
        return withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async (lease) => lease.scheduled);
      })();
    });
    runLater.resolve();
    expect(await later).toBe(true);
  });

  test("interactive work preempts an active background lease", async () => {
    const started = deferred();
    const order: string[] = [];
    let backgroundAborted = false;

    const background = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background", purpose: "cortex" },
      async (lease) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          lease.signal.addEventListener("abort", () => {
            backgroundAborted = true;
            resolve();
          }, { once: true });
        });
      },
    );
    await started.promise;

    const interactive = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_B, requestClass: "interactive", purpose: "chat" },
      async () => {
        order.push("chat");
      },
    );
    await flush();

    expect(backgroundAborted).toBe(true);
    await background;
    await interactive;
    expect(order).toEqual(["chat"]);
  });

  test("does not preempt when the setting is disabled", async () => {
    __test__.setConfig(config({ preemptBackground: false }));
    const started = deferred();
    const release = deferred();
    let backgroundAborted = false;

    const background = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background" },
      async (lease) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          lease.signal.addEventListener("abort", () => {
            backgroundAborted = true;
            resolve();
          }, { once: true });
          release.promise.then(resolve);
        });
      },
    );
    await started.promise;

    const interactive = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async () => {},
    );
    await flush();
    expect(backgroundAborted).toBe(false);

    release.resolve();
    await background;
    await interactive;
  });

  test("serves queued work by class before arrival order", async () => {
    const order: string[] = [];
    const gate = deferred();
    const holder = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk", purpose: "holder" },
      async () => {
        await gate.promise;
      },
    );
    await flush();

    const bulk = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk", purpose: "bulk" },
      async () => order.push("bulk"),
    );
    const retrieval = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "retrieval", purpose: "retrieval" },
      async () => order.push("retrieval"),
    );
    await flush();

    gate.resolve();
    await Promise.all([holder, bulk, retrieval]);
    expect(order).toEqual(["retrieval", "bulk"]);
  });

  test("shared resources keep the smallest participant concurrency", async () => {
    __test__.setConfigForUser(new Map([
      ["user-a", config({ concurrency: 1 })],
      ["user-b", config({ concurrency: 8 })],
    ]));

    const order: string[] = [];
    const holdingA = deferred();
    const a = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        await holdingA.promise;
      },
    );
    await flush();

    const b = withInferenceLease(
      { userId: "user-b", endpoint: ENDPOINT_B, requestClass: "bulk" },
      async () => order.push("b"),
    );
    await flush();

    // B's higher limit must not raise A's resource above 1.
    const status = getInferenceSchedulerStatus("user-b");
    expect(status.resources[0]?.concurrency).toBe(1);
    expect(order).toEqual([]);

    holdingA.resolve();
    await a;
    await b;
    expect(order).toEqual(["b"]);

    // Once A is idle, B's own limit applies again and can run concurrently.
    const holdingB = deferred();
    const b1 = withInferenceLease(
      { userId: "user-b", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        await holdingB.promise;
      },
    );
    const b2 = withInferenceLease(
      { userId: "user-b", endpoint: ENDPOINT_B, requestClass: "bulk" },
      async () => order.push("b2"),
    );
    await flush();
    expect(order).toContain("b2");

    holdingB.resolve();
    await Promise.all([b1, b2]);
  });
});

describe("inference scheduler waiting", () => {
  test("rejects a queued request whose maximum wait expires", async () => {
    const gate = deferred();
    const holder = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        await gate.promise;
      },
    );
    await flush();

    const queued = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk", maxWaitMs: 10 },
      async () => {},
    );

    await expect(queued).rejects.toBeInstanceOf(InferenceQueueTimeoutError);
    gate.resolve();
    await holder;
  });

  test("rejects a queued request when the caller aborts", async () => {
    const gate = deferred();
    const holder = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        await gate.promise;
      },
    );
    await flush();

    const controller = new AbortController();
    const queued = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background", signal: controller.signal },
      async () => {},
    );
    controller.abort(new Error("stop"));
    await expect(queued).rejects.toThrow("stop");

    gate.resolve();
    await holder;
  });

  test("interactive requests wait indefinitely when maxWaitMs is configured", async () => {
    __test__.setConfig(config({ maxWaitMs: 1 }));
    const gate = deferred();
    const holder = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk" },
      async () => {
        await gate.promise;
      },
    );
    await flush();

    let ran = false;
    const interactive = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async () => {
        ran = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ran).toBe(false);

    gate.resolve();
    await holder;
    await interactive;
    expect(ran).toBe(true);
  });
});

describe("inference scheduler streams", () => {
  test("holds the resource for the stream lifetime and releases afterward", async () => {
    const order: string[] = [];
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        order.push("first");
        yield 1;
        order.push("second");
        yield 2;
      },
    );

    const values: number[] = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);

    const next = await acquireInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A });
    expect(next.lease.scheduled).toBe(true);
    next.lease.release();
  });

  test("releases when the consumer breaks early", async () => {
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        yield 1;
        yield 2;
      },
    );
    for await (const value of stream) {
      expect(value).toBe(1);
      break;
    }

    const status = getInferenceSchedulerStatus("user-a");
    expect(status.resources[0]?.active).toHaveLength(0);
  });

  test("holds the resource until asynchronous stream cleanup completes", async () => {
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        try {
          yield 1;
        } finally {
          cleanupStarted.resolve();
          await finishCleanup.promise;
        }
      },
    );
    expect((await stream.next()).value).toBe(1);

    let nextStarted = false;
    const next = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async () => { nextStarted = true; },
    );
    const closing = stream.return(undefined);
    try {
      await cleanupStarted.promise;
      await flush();
      expect(nextStarted).toBe(false);
      expect(getInferenceSchedulerStatus("user-a").resources[0]?.active).toHaveLength(1);
    } finally {
      finishCleanup.resolve();
      await closing;
      await next;
    }
    expect(nextStarted).toBe(true);
  });

  test("releases the resource even when stream cleanup throws", async () => {
    const cleanupError = new Error("provider cleanup failed");
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        try {
          yield 1;
        } finally {
          throw cleanupError;
        }
      },
    );
    await stream.next();
    await expect(stream.return(undefined)).rejects.toBe(cleanupError);

    const next = await acquireInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A, maxWaitMs: 100 });
    next.lease.release();
    expect(getInferenceSchedulerStatus("user-a").resources[0]?.active).toHaveLength(0);
  });

  test("releases the resource when the stream factory throws", async () => {
    const factoryError = new Error("provider initialization failed");
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      () => { throw factoryError; },
    );
    await expect(stream.next()).rejects.toBe(factoryError);

    const next = await acquireInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A, maxWaitMs: 100 });
    next.lease.release();
    expect(getInferenceSchedulerStatus("user-a").resources[0]?.active).toHaveLength(0);
  });

  test("stream cleanup reuses the held resource for nested calls", async () => {
    let nestedScheduled: unknown = null;
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        try {
          yield 1;
        } finally {
          await withInferenceLease(
            { userId: "user-a", endpoint: ENDPOINT_A, maxWaitMs: 100 },
            async (lease) => { nestedScheduled = lease.scheduled; },
          );
        }
      },
    );
    await stream.next();
    await stream.return(undefined);
    expect(nestedScheduled).toBe(false);
    expect(getInferenceSchedulerStatus("user-a").resources[0]?.active).toHaveLength(0);
  });

  test("nested calls inside a leased stream do not queue again", async () => {
    let nestedScheduled: unknown = null;
    const stream = withInferenceLeaseStream(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "interactive" },
      async function* () {
        await withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async (lease) => {
          nestedScheduled = lease.scheduled;
        });
        yield 1;
      },
    );
    for await (const _value of stream) { /* consume */ }
    expect(nestedScheduled).toBe(false);
  });
});

describe("inference scheduler status", () => {
  test("keeps shared-pool labels, counters, and activity timestamps private", async () => {
    const origin = new URL(ENDPOINT_A).origin;
    __test__.setConfigForUser(new Map([
      ["user-a", config({ groups: [{ id: "gpu", name: "Alice's pool", origins: [origin] }] })],
      ["user-b", config({ groups: [{ id: "gpu", name: "Bob's private pool", origins: [origin] }] })],
    ]));
    __test__.setClock(() => 100);
    await withInferenceLease({ userId: "user-a", endpoint: ENDPOINT_A }, async () => {});
    const before = getInferenceSchedulerStatus("user-a").resources[0];
    __test__.setClock(() => 200);
    await withInferenceLease({ userId: "user-b", endpoint: ENDPOINT_A }, async () => {});
    const after = getInferenceSchedulerStatus("user-a").resources[0];
    expect(after.label).toBe("Alice's pool");
    expect(after.stats).toEqual(before.stats);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(getInferenceSchedulerStatus("user-b").resources[0].stats.completed).toBe(1);
  });

  test("preemption errors do not disclose another user's request purpose", async () => {
    const started = deferred();
    let reason: Error | undefined;
    const background = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background" },
      async (lease) => {
        started.resolve();
        await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => {
          reason = lease.signal.reason;
          resolve();
        }, { once: true }));
      },
    );
    await started.promise;
    await withInferenceLease(
      { userId: "user-b", endpoint: ENDPOINT_A, requestClass: "interactive", purpose: "private-extension-name" },
      async () => {},
    );
    await background;
    expect(reason?.message).not.toContain("private-extension-name");
  });

  test("reports active and queued work to the owning user only", async () => {
    const gate = deferred();
    const active = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "bulk", purpose: "vectorize" },
      async () => {
        await gate.promise;
      },
    );
    await flush();
    const waiting = withInferenceLease(
      { userId: "user-a", endpoint: ENDPOINT_A, requestClass: "background", purpose: "cortex" },
      async () => {},
    );
    await flush();

    const status = getInferenceSchedulerStatus("user-a");
    expect(status.enabled).toBe(true);
    expect(status.resources).toHaveLength(1);
    expect(status.resources[0].active.map((entry) => entry.purpose)).toEqual(["vectorize"]);
    expect(status.resources[0].waiting.map((entry) => entry.purpose)).toEqual(["cortex"]);

    expect(getInferenceSchedulerStatus("user-b").resources).toHaveLength(0);

    gate.resolve();
    await active;
    await waiting;
  });

  test("omits queues when disabled", async () => {
    __test__.setConfig(config({ enabled: false }));
    expect(getInferenceSchedulerStatus("user-a").enabled).toBe(false);
  });
});
