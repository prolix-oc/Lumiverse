import { afterEach, describe, expect, test } from "bun:test";

import {
  enqueueChatPipelineTask,
  getChatPipelineStatus,
  resetChatPipelineCoordinatorForTests,
} from "./chat-pipeline-coordinator.service";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  resetChatPipelineCoordinatorForTests();
});

describe("chat pipeline coordinator", () => {
  test("chunk finalization waits for Cortex without aborting or superseding ingestion", async () => {
    const blocker = deferred<void>();
    const order: string[] = [];
    let activeSignal!: AbortSignal;
    const active = enqueueChatPipelineTask({
      chatId: "chat-finalize", kind: "cortex_ingest",
      run: async (signal) => { activeSignal = signal; await blocker.promise; order.push("active"); },
    });
    const queued = enqueueChatPipelineTask({
      chatId: "chat-finalize", kind: "cortex_ingest",
      run: async () => { order.push("queued"); },
    });
    const finalized = enqueueChatPipelineTask({
      chatId: "chat-finalize", kind: "chunk_finalize",
      run: async () => { order.push("finalized"); },
    });
    expect(activeSignal.aborted).toBe(false);
    expect(getChatPipelineStatus("chat-finalize")?.queuedCounts.chunk_finalize).toBe(1);
    blocker.resolve();
    expect((await Promise.all([active, queued, finalized])).map((result) => result.status)).toEqual(["completed", "completed", "completed"]);
    expect(order).toEqual(["active", "queued", "finalized"]);
  });

  test("chunk rebuilds abort active cortex work and supersede queued ingests", async () => {
    const order: string[] = [];

    const active = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 1,
      run: async (signal) => {
        order.push("ingest-active:start");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            order.push("ingest-active:aborted");
            resolve();
          }, { once: true });
        });
      },
    });

    await Promise.resolve();

    const queued = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "cortex_ingest",
      dedupeKey: "chunk-2",
      revision: 1,
      run: async () => {
        order.push("ingest-queued");
      },
    });

    const rebuild = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "chunk_rebuild",
      exclusive: true,
      run: async () => {
        order.push("rebuild");
      },
    });

    expect((await queued).status).toBe("superseded");

    expect((await active).status).toBe("superseded");
    expect((await rebuild).status).toBe("completed");
    expect(order).toEqual(["ingest-active:start", "ingest-active:aborted", "rebuild"]);

    const status = getChatPipelineStatus("chat-a");
    expect(status?.supersededTasks).toBe(2);
    expect(status?.queuedCounts.cortex_ingest).toBe(0);
  });

  test("newer queued ingests replace older queued ingests for the same chunk", async () => {
    const blocker = deferred<void>();
    const order: string[] = [];

    const warmup = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_warmup",
      exclusive: true,
      run: async () => {
        order.push("warmup:start");
        await blocker.promise;
        order.push("warmup:end");
      },
    });

    await Promise.resolve();

    const older = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 1,
      run: async () => {
        order.push("older-ingest");
      },
    });

    const newer = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 2,
      run: async () => {
        order.push("newer-ingest");
      },
    });

    expect((await older).status).toBe("superseded");

    blocker.resolve();

    expect((await warmup).status).toBe("completed");
    expect((await newer).status).toBe("completed");
    expect(order).toEqual(["warmup:start", "warmup:end", "newer-ingest"]);
  });
});
