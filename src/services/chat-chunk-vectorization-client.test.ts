import { afterEach, describe, expect, it } from "bun:test";
import { DatabaseGenerationCancelledError } from "../db/connection";
import {
  __test__,
  canUseChatChunkVectorizationSubprocess,
  processChatChunkVectorizationBatchInSubprocess,
  shutdownChatChunkVectorizationSubprocess,
} from "./chat-chunk-vectorization-client";

describe("canUseChatChunkVectorizationSubprocess", () => {
  it("defaults to enabled on non-Windows runtimes", () => {
    expect(canUseChatChunkVectorizationSubprocess("linux", {})).toBe(true);
  });

  it("turns off only when explicitly set to false", () => {
    expect(canUseChatChunkVectorizationSubprocess("linux", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "false",
    })).toBe(false);
    expect(canUseChatChunkVectorizationSubprocess("linux", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "true",
    })).toBe(true);
  });

  it("disables the subprocess on Windows by default", () => {
    expect(canUseChatChunkVectorizationSubprocess("win32", {})).toBe(false);
  });

  it("allows an explicit Windows subprocess override", () => {
    expect(canUseChatChunkVectorizationSubprocess("win32", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "true",
    })).toBe(true);
  });
});
type WorkerHarness = {
  messages: unknown[];
  kills: string[];
  ipc: (message: unknown) => void;
  exit: () => void;
};

function messageOfType(value: unknown, type: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && "type" in value && value.type === type;
}

async function waitForMessage(harness: WorkerHarness, type: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = harness.messages.find((candidate) => messageOfType(candidate, type));
    if (message && messageOfType(message, type)) return message;
    await Bun.sleep(0);
  }
  throw new Error(`Timed out waiting for worker message ${type}`);
}

afterEach(() => {
  __test__.reset();
});

describe("chat chunk vectorization subprocess generation lifecycle", () => {
  it("terminates an active old-generation worker and ignores its late completion", async () => {
    const workers: WorkerHarness[] = [];
    __test__.setForceKillGraceMs(1);
    __test__.setSubprocessFactory((options) => {
      const harness: WorkerHarness = { messages: [], kills: [], ipc: options.ipc, exit: () => undefined };
      workers.push(harness);
      const fakeProcess = {
        send(message: unknown) { harness.messages.push(message); },
        kill(signal: string) { harness.kills.push(signal); },
      };
      harness.exit = () => options.onExit(fakeProcess as unknown as ReturnType<typeof Bun.spawn>, null, 15);
      queueMicrotask(() => options.ipc({ type: "ready" }));
      // The production client only uses send/kill; the seam deliberately models that boundary.
      return fakeProcess as unknown as ReturnType<typeof Bun.spawn>;
    });

    const firstController = new AbortController();
    const first = processChatChunkVectorizationBatchInSubprocess([
      { userId: "owner", chatId: "chat", chunkId: "old-chunk" },
    ], 41, firstController.signal);
    const firstRequest = await waitForMessage(workers[0]!, "process_batch");
    expect(firstRequest.generation).toBe(41);

    firstController.abort(new DatabaseGenerationCancelledError(41, 42));
    await expect(first).rejects.toMatchObject({
      code: "database_generation_cancelled",
      admittedGeneration: 41,
      currentGeneration: 42,
    });
    expect(workers[0]!.messages.some((message) => (
      messageOfType(message, "cancel_generation") && message.generation === 41
    ))).toBe(true);
    expect(workers[0]!.kills).toContain("SIGTERM");

    const secondController = new AbortController();
    const second = processChatChunkVectorizationBatchInSubprocess([
      { userId: "owner", chatId: "chat", chunkId: "new-chunk" },
    ], 42, secondController.signal);
    await Bun.sleep(0);
    expect(workers).toHaveLength(1);
    await Bun.sleep(5);
    expect(workers[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(workers).toHaveLength(1);
    workers[0]!.exit();
    const secondRequest = await waitForMessage(workers[1]!, "process_batch");
    const firstRequestId = firstRequest.requestId;
    const secondRequestId = secondRequest.requestId;
    if (typeof firstRequestId !== "string" || typeof secondRequestId !== "string") {
      throw new Error("Worker requests must include request ids");
    }

    workers[0]!.ipc({
      type: "result",
      requestId: firstRequestId,
      generation: 41,
      result: { processedCount: 1, failedChunkIds: [], refreshedChatIds: ["stale"] },
    });
    workers[1]!.ipc({
      type: "result",
      requestId: secondRequestId,
      generation: 42,
      result: { processedCount: 1, failedChunkIds: [], refreshedChatIds: ["chat"] },
    });

    await expect(second).resolves.toEqual({
      processedCount: 1,
      failedChunkIds: [],
      refreshedChatIds: ["chat"],
    });
  });
  it("bounds an ignore-shutdown worker through cooperative grace, TERM, KILL, and observed exit", async () => {
    let worker!: WorkerHarness;
    __test__.setShutdownCooperativeGraceMs(1);
    __test__.setForceKillGraceMs(1);
    __test__.setSubprocessFactory((options) => {
      const harness: WorkerHarness = { messages: [], kills: [], ipc: options.ipc, exit: () => undefined };
      worker = harness;
      const fakeProcess = {
        send(message: unknown) { harness.messages.push(message); },
        kill(signal: string) { harness.kills.push(signal); },
      };
      harness.exit = () => options.onExit(fakeProcess as unknown as ReturnType<typeof Bun.spawn>, null, 9);
      queueMicrotask(() => options.ipc({ type: "ready" }));
      return fakeProcess as unknown as ReturnType<typeof Bun.spawn>;
    });

    const controller = new AbortController();
    const batch = processChatChunkVectorizationBatchInSubprocess([
      { userId: "owner", chatId: "chat", chunkId: "shutdown-chunk" },
    ], 51, controller.signal);
    await waitForMessage(worker, "process_batch");
    let settlements = 0;
    const observedBatch = batch.catch((error) => {
      settlements += 1;
      throw error;
    });

    const shutdown = shutdownChatChunkVectorizationSubprocess();
    let shutdownSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    await expect(observedBatch).rejects.toThrow("shutting down");
    expect(worker.messages.some((message) => messageOfType(message, "shutdown"))).toBe(true);
    await expect(processChatChunkVectorizationBatchInSubprocess([
      { userId: "owner", chatId: "chat", chunkId: "late-admission" },
    ], 51, new AbortController().signal)).rejects.toThrow("shutting down");

    await Bun.sleep(5);
    expect(worker.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(shutdownSettled).toBe(false);
    expect(settlements).toBe(1);
    worker.exit();
    await shutdown;
    expect(__test__.getState()).toEqual({
      queueLength: 0,
      inflight: false,
      subprocess: false,
      retirement: false,
      shutdownRequested: true,
    });
  });
});
