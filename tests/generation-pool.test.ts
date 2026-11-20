import { afterEach, describe, expect, test } from "bun:test";
import {
  appendPoolContent,
  appendPoolReasoning,
  clearAllPoolEntries,
  completePool,
  createPoolEntry,
  getPoolEntry,
  getPoolForChat,
  stopPoolSweep,
  sweepPoolNow,
} from "../src/services/generation-pool.service";

// The module auto-starts its interval sweep on import; stop it so the test
// process exits cleanly.
stopPoolSweep();

function makeEntry(generationId = "gen-1") {
  createPoolEntry({
    generationId,
    userId: "user-1",
    chatId: "chat-1",
    generationType: "normal",
    characterName: "Testa",
    model: "test-model",
  });
}

afterEach(() => {
  clearAllPoolEntries();
});

describe("pool append offsets", () => {
  test("content appends return monotonically increasing seq and char offsets", () => {
    makeEntry();
    expect(appendPoolContent("gen-1", "Hello")).toEqual({ seq: 1, offset: 0 });
    expect(appendPoolContent("gen-1", ", world")).toEqual({ seq: 2, offset: 5 });
    expect(appendPoolContent("gen-1", "!")).toEqual({ seq: 3, offset: 12 });
    expect(getPoolEntry("gen-1")!.content).toBe("Hello, world!");
  });

  test("content and reasoning offsets track their own buffers while seq is shared", () => {
    makeEntry();
    expect(appendPoolReasoning("gen-1", "think")).toEqual({ seq: 1, offset: 0 });
    expect(appendPoolContent("gen-1", "Hi")).toEqual({ seq: 2, offset: 0 });
    expect(appendPoolReasoning("gen-1", " more")).toEqual({ seq: 3, offset: 5 });
    expect(appendPoolContent("gen-1", " there")).toEqual({ seq: 4, offset: 2 });
    const entry = getPoolEntry("gen-1")!;
    expect(entry.content).toBe("Hi there");
    expect(entry.reasoning).toBe("think more");
    expect(entry.tokenSeq).toBe(4);
  });

  test("appends against an unknown generation are inert", () => {
    expect(appendPoolContent("missing", "x")).toEqual({ seq: 0, offset: 0 });
  });
});

describe("stale non-terminal failsafe", () => {
  test("sweep force-errors entries with no activity past the timeout", () => {
    makeEntry();
    appendPoolContent("gen-1", "partial");
    const entry = getPoolEntry("gen-1")!;
    // Simulate a hung generation: last activity far in the past.
    entry.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;

    sweepPoolNow();

    const after = getPoolEntry("gen-1")!;
    expect(after.status).toBe("error");
    expect(after.error).toContain("timed out");
    expect(after.completedAt).toBeNumber();
  });

  test("sweep leaves recently-active generations alone", () => {
    makeEntry();
    appendPoolContent("gen-1", "tokens flowing");

    sweepPoolNow();

    expect(getPoolEntry("gen-1")!.status).toBe("streaming");
    expect(getPoolForChat("user-1", "chat-1")?.generationId).toBe("gen-1");
  });

  test("completed generations are not touched by the failsafe", () => {
    makeEntry();
    appendPoolContent("gen-1", "done");
    completePool("gen-1", "msg-1");
    const entry = getPoolEntry("gen-1")!;
    entry.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;

    sweepPoolNow();

    expect(getPoolEntry("gen-1")!.status).toBe("completed");
  });
});
