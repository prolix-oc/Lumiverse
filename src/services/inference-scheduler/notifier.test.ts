import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";

const emitted: Array<{ event: string; payload: any; userId?: string }> = [];

mock.module("../../ws/bus", () => ({
  eventBus: {
    emit: (event: string, payload: any, userId?: string) => {
      emitted.push({ event, payload, userId });
    },
  },
}));

const { DEFAULT_INFERENCE_SCHEDULER_CONFIG } = await import("./config");
const { __test__, withInferenceLease } = await import("./scheduler");
const notifier = await import("./notifier");

const ENDPOINT = "http://127.0.0.1:5001/v1/chat/completions";

beforeEach(() => {
  emitted.length = 0;
  notifier.stopInferenceSchedulerNotifierForTests();
  jest.useFakeTimers();
  __test__.setHost(true);
  __test__.setConfig({
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    unifiedLocalPool: true,
    concurrency: 1,
  });
});

afterEach(() => {
  notifier.stopInferenceSchedulerNotifierForTests();
  jest.useRealTimers();
  __test__.reset();
});

test("emits one debounced status event per user after queue transitions", async () => {
  await withInferenceLease(
    { userId: "user-a", endpoint: ENDPOINT, requestClass: "background" },
    async () => {},
  );
  await withInferenceLease(
    { userId: "user-a", endpoint: ENDPOINT, requestClass: "bulk" },
    async () => {},
  );

  expect(emitted).toHaveLength(0);
  jest.advanceTimersByTime(notifier.__test__.debounceMs + 10);

  expect(emitted).toHaveLength(1);
  expect(emitted[0].event).toBe("INFERENCE_SCHEDULER_STATE");
  expect(emitted[0].userId).toBe("user-a");
  expect(emitted[0].payload.status.enabled).toBe(true);
  expect(emitted[0].payload.status.resources).toHaveLength(1);
});

test("reports an active lease while it is held", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let granted!: () => void;
  const start = new Promise<void>((resolve) => {
    granted = resolve;
  });

  const lease = withInferenceLease(
    { userId: "user-a", endpoint: ENDPOINT, requestClass: "interactive", purpose: "chat" },
    async () => {
      granted();
      await held;
    },
  );

  await start;
  jest.advanceTimersByTime(notifier.__test__.debounceMs + 10);

  const latest = emitted.at(-1)!;
  expect(latest.payload.status.resources[0].active).toHaveLength(1);
  expect(latest.payload.status.resources[0].active[0].purpose).toBe("chat");

  release();
  await lease;
});

test("keeps user queues isolated in the broadcast payload", async () => {
  await withInferenceLease(
    { userId: "user-a", endpoint: ENDPOINT, requestClass: "background" },
    async () => {},
  );
  await withInferenceLease(
    { userId: "user-b", endpoint: ENDPOINT, requestClass: "background" },
    async () => {},
  );
  jest.advanceTimersByTime(notifier.__test__.debounceMs + 10);

  expect(emitted.map((entry) => entry.userId).sort()).toEqual(["user-a", "user-b"]);
  for (const entry of emitted) {
    expect(entry.payload.status.resources).toHaveLength(1);
    expect(entry.payload.status.resources[0].active).toHaveLength(0);
  }
});
