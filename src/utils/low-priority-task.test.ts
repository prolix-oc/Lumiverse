import { afterEach, describe, expect, test } from "bun:test";
import {
  resetLowPriorityTasksForTests,
  scheduleLowPriorityTask,
  waitForLowPriorityTasksForTests,
} from "./low-priority-task";

afterEach(() => {
  resetLowPriorityTasksForTests();
});

describe("scheduleLowPriorityTask", () => {
  test("runs work on a later macrotask and preserves start order", async () => {
    const events: string[] = [];

    scheduleLowPriorityTask(() => {
      events.push("first");
    });
    scheduleLowPriorityTask(() => {
      events.push("second");
    });

    events.push("sync");
    expect(events).toEqual(["sync"]);

    await waitForLowPriorityTasksForTests();
    expect(events).toEqual(["sync", "first", "second"]);
  });

  test("waits for async work to settle before the test drain resolves", async () => {
    const events: string[] = [];

    scheduleLowPriorityTask(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      events.push("async");
    });

    await waitForLowPriorityTasksForTests();
    expect(events).toEqual(["async"]);
  });
});
