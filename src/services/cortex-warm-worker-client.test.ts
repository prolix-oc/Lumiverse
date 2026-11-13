import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CortexWarmJob } from "./cortex-warm-worker";

const SUPERSEDED = { mainResult: null, linkedResult: null };

type Admission = {
  options: { signal?: AbortSignal };
  controller: AbortController;
  leaseSignal: AbortSignal | null;
  grant: () => Promise<unknown>;
  rejected: boolean;
};

const admissions: Admission[] = [];

mock.module("./embeddings.service", () => ({
  resolvePrimaryEmbeddingEndpoint: () => "http://127.0.0.1:5001",
}));

mock.module("./inference-scheduler", () => ({
  isInferenceSchedulingEnabled: () => true,
  withInferenceLease: (
    options: { signal?: AbortSignal },
    fn: (lease: { scheduled: boolean; signal: AbortSignal }) => Promise<unknown>,
  ) => new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const admission: Admission = {
      options,
      controller,
      leaseSignal: null,
      rejected: false,
      grant: async () => {
        admission.leaseSignal = controller.signal;
        try {
          const value = await fn({ scheduled: true, signal: controller.signal });
          settle(() => resolve(value));
        } catch (err) {
          settle(() => reject(err));
        }
      },
    };
    // The client aborts its own waiting controller; mirror the real scheduler's
    // rejection so a superseded admission settles as a no-op.
    options.signal?.addEventListener("abort", () => {
      admission.rejected = true;
      settle(() => reject(options.signal?.reason));
    }, { once: true });
    admissions.push(admission);
  }),
}));

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: Array<{ requestId: string; type: string }> = [];
  terminated = false;
  private listeners = new Map<string, Array<() => void>>();
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(request: { requestId: string; type: string }) {
    this.requests.push(request);
  }
  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  terminate() {
    this.terminated = true;
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
  respond(requestId: string) {
    this.onmessage?.({ data: { type: "result", requestId, result: SUPERSEDED } } as MessageEvent);
  }
}

const originalWorker = globalThis.Worker;
globalThis.Worker = FakeWorker as unknown as typeof Worker;

const client = await import("./cortex-warm-worker-client");

function job(chatId: string): CortexWarmJob {
  return {
    chatId,
    userId: "warm-user",
    cortexConfig: {} as never,
    mainQuery: {} as never,
    linkedQueryText: "",
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  admissions.length = 0;
  FakeWorker.all = [];
});

afterEach(() => {
  client.resetCortexWarmWorkerForTests();
  admissions.length = 0;
});

describe("cortex warm job admission", () => {
  test("a newer request supersedes waiting admissions for the same chat before they run", async () => {
    const first = client.warmCortexInWorker(job("chat-1"));
    const second = client.warmCortexInWorker(job("chat-1"));
    const third = client.warmCortexInWorker(job("chat-1"));

    expect(await first).toEqual(SUPERSEDED);
    expect(await second).toEqual(SUPERSEDED);
    expect(admissions).toHaveLength(3);
    expect(admissions[0].rejected).toBe(true);
    expect(admissions[1].rejected).toBe(true);
    expect(admissions[2].rejected).toBe(false);

    void admissions[2].grant();
    await flush();
    const worker = FakeWorker.all[0];
    expect(worker).toBeDefined();
    expect(worker.requests).toHaveLength(1);
    worker.respond(worker.requests[0].requestId);
    expect(await third).toEqual(SUPERSEDED);
  });

  test("different chats wait independently", async () => {
    const a = client.warmCortexInWorker(job("chat-a"));
    const b = client.warmCortexInWorker(job("chat-b"));
    expect(admissions).toHaveLength(2);
    expect(admissions[0].rejected).toBe(false);
    expect(admissions[1].rejected).toBe(false);
    client.resetCortexWarmWorkerForTests();
    await Promise.all([a, b]);
  });

  test("preemption terminates the running worker and resolves as a no-op", async () => {
    const pending = client.warmCortexInWorker(job("chat-preempt"));
    void admissions[0].grant();
    await flush();

    const worker = FakeWorker.all[0];
    expect(worker).toBeDefined();
    expect(worker.requests).toHaveLength(1);

    admissions[0].controller.abort(new Error("preempted"));
    await expect(pending).resolves.toEqual(SUPERSEDED);
    expect(worker.terminated).toBe(true);
  });

  test("preemption while still queued never starts a worker", async () => {
    const first = client.warmCortexInWorker(job("chat-q1"));
    void admissions[0].grant();
    await flush();
    const worker = FakeWorker.all[0];

    const queued = client.warmCortexInWorker(job("chat-q2"));
    void admissions[1].grant();
    await flush();
    // chat-q2 is queued behind chat-q1's in-flight job.
    expect(worker.requests).toHaveLength(1);

    admissions[1].controller.abort(new Error("preempted"));
    await expect(queued).resolves.toEqual(SUPERSEDED);

    worker.respond(worker.requests[0].requestId);
    await expect(first).resolves.toEqual(SUPERSEDED);
  });
});
