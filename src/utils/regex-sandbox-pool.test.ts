import { beforeEach, describe, expect, test } from "bun:test";
import {
  IsolatePoolError,
  IsolatePoolV1,
  resetIsolateHealthForTests,
  type IsolateTransport,
} from "../services/isolate-pool";
import {
  decodeLengthPrefixedJson,
  isIsolateStartedEnvelopeV1,
  makeResultEnvelopeV1,
  makeStartedEnvelopeV1,
} from "../services/isolate-protocol";

class FakeTransport implements IsolateTransport {
  readonly kind = "worker" as const;
  readonly sent: Uint8Array[] = [];
  terminated = false;
  private messageHandler: ((message: unknown) => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;

  send(message: unknown): void {
    if (this.terminated) throw new Error("transport terminated");
    this.sent.push(message as Uint8Array);
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

  terminate(): void {
    this.terminated = true;
  }

  respond(message: unknown): void {
    this.messageHandler?.(message);
  }

  requestId(index = this.sent.length - 1): string {
    return decodeLengthPrefixedJson<{ requestId: string }>(this.sent[index]!).requestId;
  }
}

function createHarness(options?: { startTimeoutMs?: number; executionTimeoutMs?: number }) {
  const transports: FakeTransport[] = [];
  const pool = new IsolatePoolV1<{ value: string }, string>({
    name: "regex-test",
    backend: "worker",
    maxWorkers: 1,
    defaultTimeoutMs: options?.executionTimeoutMs ?? 100,
    workerStartTimeoutMs: options?.startTimeoutMs ?? 50,
    workerStartAcknowledgement: (message, job) =>
      isIsolateStartedEnvelopeV1(message) && message.requestId === job.requestId,
    workerFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
  });
  return { pool, transports };
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
    await Bun.sleep(1);
  }
  expect(predicate()).toBe(true);
}

beforeEach(() => resetIsolateHealthForTests());

describe("framed regex isolate timing attribution", () => {
  test("reports a missing start acknowledgement as startup rather than execution timeout", async () => {
    const { pool, transports } = createHarness({ startTimeoutMs: 5, executionTimeoutMs: 50 });
    const pending = pool.submit({
      userId: "u",
      operation: "replace",
      payload: { value: "startup" },
      timeoutMs: 50,
    });

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(IsolatePoolError);
    expect(error).toMatchObject({
      code: "worker_timed_out",
      timeoutPhase: "startup",
      timeoutMs: 5,
    });
    expect(transports[0]?.terminated).toBe(true);
    await pool.shutdown();
  });

  test("starts the execution deadline only after the framed acknowledgement", async () => {
    const { pool, transports } = createHarness({ startTimeoutMs: 100, executionTimeoutMs: 20 });
    const pending = pool.submit({
      userId: "u",
      operation: "replace",
      payload: { value: "execution" },
      timeoutMs: 10,
    });
    await waitFor(() => (transports[0]?.sent.length ?? 0) === 1);

    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    transports[0]!.respond(makeStartedEnvelopeV1(transports[0]!.requestId()));
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({
      code: "worker_timed_out",
      timeoutPhase: "execution",
      timeoutMs: 10,
    });
    await pool.shutdown();
  });

  test("does not consume a queued request's execution budget", async () => {
    const { pool, transports } = createHarness({ startTimeoutMs: 100, executionTimeoutMs: 100 });
    const first = pool.submit({
      userId: "u",
      operation: "replace",
      payload: { value: "first" },
      timeoutMs: 100,
    });
    await waitFor(() => (transports[0]?.sent.length ?? 0) === 1);
    const firstId = transports[0]!.requestId(0);
    transports[0]!.respond(makeStartedEnvelopeV1(firstId));

    const second = pool.submit({
      userId: "u",
      operation: "replace",
      payload: { value: "second" },
      timeoutMs: 5,
    });
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await Bun.sleep(15);
    expect(secondSettled).toBe(false);

    transports[0]!.respond(makeResultEnvelopeV1(firstId, "first"));
    expect(await first).toBe("first");
    await waitFor(() => transports[0]!.sent.length === 2);
    const secondId = transports[0]!.requestId(1);
    transports[0]!.respond(makeStartedEnvelopeV1(secondId));
    transports[0]!.respond(makeResultEnvelopeV1(secondId, "second"));
    expect(await second).toBe("second");
    await pool.shutdown();
  });

  test("rejects a terminal response that arrives before acknowledgement", async () => {
    const { pool, transports } = createHarness();
    const pending = pool.submit({
      userId: "u",
      operation: "replace",
      payload: { value: "unordered" },
    });
    await waitFor(() => (transports[0]?.sent.length ?? 0) === 1);
    transports[0]!.respond(makeResultEnvelopeV1(transports[0]!.requestId(), "unordered"));
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({ code: "worker_malformed" });
    await pool.shutdown();
  });
});
