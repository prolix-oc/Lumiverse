import { afterEach, describe, expect, test } from "bun:test";

import {
  resetCortexSidecarRpmGateForTests,
  waitForCortexSidecarRpmSlot,
} from "./sidecar-rpm-gate";

afterEach(() => {
  resetCortexSidecarRpmGateForTests();
});

describe("waitForCortexSidecarRpmSlot", () => {
  test("delays requests beyond the per-chat RPM limit", async () => {
    const start = Date.now();

    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 2,
      windowMs: 60,
    });
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 2,
      windowMs: 60,
    });
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 2,
      windowMs: 60,
    });

    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  test("throttles across chats when the provider matches", async () => {
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 1,
      windowMs: 80,
    });

    const start = Date.now();
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 1,
      windowMs: 80,
    });

    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });

  test("does not throttle different providers together", async () => {
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "openrouter",
      requestsPerMinute: 1,
      windowMs: 80,
    });

    const start = Date.now();
    await waitForCortexSidecarRpmSlot({
      userId: "user-1",
      provider: "anthropic",
      requestsPerMinute: 1,
      windowMs: 80,
    });

    expect(Date.now() - start).toBeLessThan(40);
  });
});
