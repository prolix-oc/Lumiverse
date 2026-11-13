import { expect, test } from "bun:test";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { CortexActivityTracker, getCortexActivity, trackCortexRequest, withCortexBatch, updateCortexActivity } from "./activity";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("reports queued work before it runs and tracks simultaneous batch phases independently", async () => {
  const chatId = crypto.randomUUID();
  const emitted: any[] = [];
  const off = eventBus.on(EventType.CORTEX_ACTIVITY, (event) => { if (event.payload.chatId === chatId) emitted.push(event.payload); });
  const tracker = new CortexActivityTracker("user", chatId, "rebuild");
  await Bun.sleep(1);
  expect(emitted[0].runs[0]).toMatchObject({ phase: "queued", status: "processing" });
  const first = latch(), second = latch();
  try {
    const running = tracker.run(async () => {
      updateCortexActivity({ totalChunks: 7, totalBatches: 2 });
      await Promise.all([
        withCortexBatch(1, 5, async () => {
          const request = trackCortexRequest("analysis", "model-a");
          request.phase("waiting"); request.phase("thinking");
          await first.promise;
          request.finish();
          updateCortexActivity({ completedChunks: 5 });
        }),
        withCortexBatch(2, 2, async () => {
          const request = trackCortexRequest("analysis", "model-b");
          request.phase("waiting"); request.phase("responding");
          await second.promise;
          request.finish();
        }),
      ]);
    });
    let snapshot = getCortexActivity(chatId);
    expect(snapshot.runs[0].requests.map((request) => [request.batch, request.chunks, request.phase]))
      .toEqual([[1, 5, "thinking"], [2, 2, "responding"]]);
    expect(snapshot.runs[0].completedBatches).toBe(0);
    expect(snapshot.runs[0].requests.every((request) => request.sentAt && request.firstContentAt)).toBe(true);
    const revision = snapshot.revision;
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    snapshot = getCortexActivity(chatId);
    expect(snapshot.revision).toBeGreaterThan(revision);
    expect(snapshot.runs[0]).toMatchObject({ completedChunks: 5, completedBatches: 1 });
    expect(snapshot.runs[0].requests.map((request) => request.batch)).toEqual([2]);
    second.release();
    await running;
    expect(getCortexActivity(chatId).runs[0].completedBatches).toBe(2);
  } finally { first.release(); second.release(); tracker.finish(); off(); }
  expect(getCortexActivity(chatId).runs[0]).toMatchObject({ status: "complete", requests: [], activeBatches: [] });
});

test("failed requests and batches cannot leave ghost activity or count as completed batches", async () => {
  const chatId = crypto.randomUUID();
  const tracker = new CortexActivityTracker("user", chatId, "ingestion");
  try {
    await expect(tracker.run(() => withCortexBatch(1, 1, async () => {
      const request = trackCortexRequest("candidate review");
      try { request.phase("waiting"); throw new Error("cancelled"); }
      finally { request.finish(); }
    }))).rejects.toThrow("cancelled");
    expect(getCortexActivity(chatId).runs[0]).toMatchObject({ requests: [], activeBatches: [], completedBatches: 0 });
  } finally { tracker.finish("cancelled"); }
});

test("token activity is throttled without broadcasting model content", async () => {
  const chatId = crypto.randomUUID();
  let events = 0;
  const off = eventBus.on(EventType.CORTEX_ACTIVITY, (event) => { if (event.payload.chatId === chatId) events++; });
  const tracker = new CortexActivityTracker("user", chatId, "rebuild");
  try {
    await tracker.run(async () => {
      const request = trackCortexRequest("analysis");
      request.phase("thinking");
      await Bun.sleep(5);
      const before = events;
      for (let i = 0; i < 1000; i++) request.phase("thinking");
      expect(events).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(events).toBe(before + 1);
      expect(Object.keys(getCortexActivity(chatId).runs[0].requests[0]).sort()).toEqual(
        ["id", "batch", "chunks", "purpose", "model", "phase", "queuedAt", "updatedAt", "firstContentAt"].sort());
      request.finish();
    });
  } finally { tracker.finish(); off(); }
});

test("completed ingestion history stays bounded during a burst of work", () => {
  const chatId = crypto.randomUUID();
  const active = new CortexActivityTracker("user", chatId, "rebuild");
  try {
    for (let i = 0; i < 100; i++) new CortexActivityTracker("user", chatId, "ingestion").finish();
    const runs = getCortexActivity(chatId).runs;
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.status === "processing")).toHaveLength(1);
  } finally { active.finish(); }
});
