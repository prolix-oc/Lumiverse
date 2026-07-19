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
  test("exclusive tasks supersede queued ingests and wait for the active task", async () => {
    const blocker = deferred<void>();
    const order: string[] = [];

    const active = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 1,
      run: async () => {
        order.push("ingest-active:start");
        await blocker.promise;
        order.push("ingest-active:end");
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

    blocker.resolve();

    expect((await active).status).toBe("completed");
    expect((await rebuild).status).toBe("completed");
    expect(order).toEqual(["ingest-active:start", "ingest-active:end", "rebuild"]);

    const status = getChatPipelineStatus("chat-a");
    expect(status?.supersededTasks).toBe(1);
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
