import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import * as connections from "../connections.service";
import * as secrets from "../secrets.service";
import * as pool from "../generation-pool.service";
import { quietGenerate, quietGenerateStream, rawGenerateStream } from "./direct-generation";
import { stopAllGenerations, stopGenerationSweep } from "../generate.service";
import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "../inference-scheduler/config";
import {
  __test__ as schedulerTest,
  getInferenceSchedulerStatus,
  withInferenceLease,
} from "../inference-scheduler/scheduler";

const userId = "direct-generation-preemption";
const LOCAL_ENDPOINT = "http://127.0.0.1:5998";
let connectionId: string;
let secretSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  connectionId = (await connections.createConnection(userId, {
    name: "Local mock",
    provider: "custom",
    api_url: LOCAL_ENDPOINT,
    model: "local-model",
    is_default: true,
  })).id;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  schedulerTest.reset();
});

afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  pool.stopPoolSweep();
  pool.clearAllPoolEntries();
  secretSpy.mockRestore();
  closeDatabase();
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
}

test("a preempted quiet generation rejects instead of returning partial content", async () => {
  schedulerTest.setHost(true);
  schedulerTest.setConfig({
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    unifiedLocalPool: true,
    concurrency: 1,
    preemptBackground: true,
  });

  // The provider ignores the abort and returns a normal-looking completion.
  // Without the post-consumption lease check this would resolve with "partial".
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    await Bun.sleep(150);
    return Response.json({
      choices: [{ message: { content: "partial" }, finish_reason: "stop" }],
    });
  }) as unknown as typeof fetch);

  const quiet = quietGenerate(userId, {
    connection_id: connectionId,
    messages: [{ role: "user", content: "Hello" }],
  }, {
    origin: { kind: "sidecar", name: "Preemption test", operation: "analysis" },
    leaseClass: "background",
    leasePurpose: "quiet-generate",
  });

  await waitFor(() => getInferenceSchedulerStatus(userId).resources
    .some((resource) => resource.active.some((lease) => lease.purpose === "quiet-generate")));

  let interactiveRan = false;
  const interactive = withInferenceLease(
    {
      userId,
      endpoint: LOCAL_ENDPOINT,
      requestClass: "interactive",
      purpose: "chat",
    },
    async () => {
      interactiveRan = true;
    },
  );

  const outcome = await quiet.then(
    () => ({ resolved: true as const }),
    (error: { code?: string; message?: string }) => ({ resolved: false as const, error }),
  );

  expect(outcome.resolved).toBe(false);
  if (!outcome.resolved) {
    expect(outcome.error.code).toBe("INFERENCE_PREEMPTED");
    expect(outcome.error.message).not.toContain("partial");
  }

  await interactive;
  expect(interactiveRan).toBe(true);
}, 10_000);

for (const entryPoint of ["quiet", "raw"] as const) {
  const startStream = () => entryPoint === "quiet"
    ? quietGenerateStream(userId, {
        connection_id: connectionId,
        messages: [{ role: "user", content: "Hello" }],
      }, { leaseClass: "background", leasePurpose: `${entryPoint}-stream` })
    : rawGenerateStream(userId, {
        provider: "custom",
        connection_id: connectionId,
        model: "local-model",
        messages: [{ role: "user", content: "Hello" }],
      }, { leaseClass: "background", leasePurpose: `${entryPoint}-stream` });

  test(`a preempted ${entryPoint} stream rejects after partial output and cleans up before admitting chat`, async () => {
    schedulerTest.setHost(true);
    schedulerTest.setConfig({ ...DEFAULT_INFERENCE_SCHEDULER_CONFIG, enabled: true });

    let cleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let cleanupFinished = false;
    let cancelCount = 0;
    let transportSignal: AbortSignal | null | undefined;

    // Exercise the real CustomProvider: its SSE transport deliberately ends
    // normally on abort, leaving the lease wrapper responsible for the error.
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      transportSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ));
        },
        async cancel() {
          cancelCount += 1;
          cleanupStarted();
          await cleanupGate;
          cleanupFinished = true;
        },
      }));
    }) as typeof fetch);

    const stream = await startStream();
    const first = await stream.next();
    expect(first.done).toBe(false);
    if (first.done) throw new Error("Expected the partial provider response");
    expect(first.value.token).toBe("partial");

    const outcomePromise = stream.next().then(
      () => ({ resolved: true as const }),
      (error: { code?: string }) => ({ resolved: false as const, error }),
    );
    let admittedAfterCleanup = false;
    const interactive = withInferenceLease(
      { userId, endpoint: LOCAL_ENDPOINT, requestClass: "interactive", purpose: "chat" },
      async () => { admittedAfterCleanup = cleanupFinished; },
    );

    try {
      await cleanupStartedPromise;
      const resource = getInferenceSchedulerStatus(userId).resources[0]!;
      expect(resource.active.map((lease) => lease.purpose)).toEqual([`${entryPoint}-stream`]);
      expect(resource.waiting.map((request) => request.purpose)).toEqual(["chat"]);
    } finally {
      finishCleanup();
    }

    const outcome = await outcomePromise;
    await interactive;
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) expect(outcome.error.code).toBe("INFERENCE_PREEMPTED");
    expect(cancelCount).toBe(1);
    expect(transportSignal?.aborted).toBe(true);
    expect(admittedAfterCleanup).toBe(true);
    expect(getInferenceSchedulerStatus(userId).resources.every(
      (resource) => resource.active.length === 0 && resource.waiting.length === 0,
    )).toBe(true);
  }, 10_000);

  test(`a ${entryPoint} stream still completes normally without preemption`, async () => {
    schedulerTest.setHost(true);
    schedulerTest.setConfig({ ...DEFAULT_INFERENCE_SCHEDULER_CONFIG, enabled: true });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(
      'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )) as unknown as typeof fetch);

    const tokens: string[] = [];
    let finishReason: string | undefined;
    for await (const chunk of await startStream()) {
      if (chunk.token) tokens.push(chunk.token);
      if (chunk.finish_reason) finishReason = chunk.finish_reason;
    }

    expect(tokens).toEqual(["complete"]);
    expect(finishReason).toBe("stop");
    expect(getInferenceSchedulerStatus(userId).resources.every(
      (resource) => resource.active.length === 0 && resource.waiting.length === 0,
    )).toBe(true);
  });
}
