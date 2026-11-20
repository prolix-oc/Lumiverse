import { describe, expect, test } from "bun:test";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

async function flushEventQueue(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Spindle batch event transaction boundary", () => {
  test("discards per-operation events on rollback and emits one coalesced event after commit", async () => {
    let entryChanged = 0;
    let batchChanged = 0;
    const removeEntryListener = eventBus.on(EventType.WORLD_BOOK_ENTRY_CHANGED, () => {
      entryChanged++;
    });
    const removeBatchListener = eventBus.on(EventType.SPINDLE_BATCH_CHANGED, () => {
      batchChanged++;
    });

    try {
      expect(() => eventBus.withBufferedEvents(() => {
        eventBus.emit(EventType.WORLD_BOOK_ENTRY_CHANGED, { id: "rolled-back" }, "h12-owner");
        throw new Error("force rollback");
      })).toThrow("force rollback");
      await flushEventQueue();
      expect(entryChanged).toBe(0);
      expect(batchChanged).toBe(0);

      const committed = eventBus.withBufferedEvents(() => {
        eventBus.emit(EventType.WORLD_BOOK_ENTRY_CHANGED, { id: "first" }, "h12-owner");
        eventBus.emit(EventType.WORLD_BOOK_ENTRY_CHANGED, { id: "second" }, "h12-owner");
        return "committed";
      });
      expect(committed.events).toHaveLength(2);
      eventBus.emit(EventType.SPINDLE_BATCH_CHANGED, {
        operationCount: 2,
        sourceEvents: [EventType.WORLD_BOOK_ENTRY_CHANGED],
      }, "h12-owner");
      await flushEventQueue();
      expect(entryChanged).toBe(0);
      expect(batchChanged).toBe(1);
    } finally {
      removeEntryListener();
      removeBatchListener();
    }
  });
});
