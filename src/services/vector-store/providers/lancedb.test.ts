import { describe, expect, test } from "bun:test";
import {
  isRetryableLanceWriteConflict,
  shouldUseCrossProcessWriteLock,
} from "./lancedb";

describe("lancedb write conflict handling", () => {
  test("enables cross-process write locking by default", () => {
    expect(shouldUseCrossProcessWriteLock({})).toBe(true);
  });

  test("allows explicitly disabling cross-process write locking", () => {
    expect(shouldUseCrossProcessWriteLock({
      LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
    })).toBe(false);
  });

  test("detects Lance retryable commit conflicts from Windows warning text", () => {
    const err = new Error(
      "lance error: Retryable commit conflict for version 786: "
      + "This CreateIndex transaction was preempted by concurrent transaction CreateIndex at version 786. Please retry.",
    );
    expect(isRetryableLanceWriteConflict(err)).toBe(true);
  });

  test("ignores non-conflict Lance warnings", () => {
    expect(isRetryableLanceWriteConflict(new Error("vector not divisible by 8"))).toBe(false);
    expect(isRetryableLanceWriteConflict(new Error("table 'embeddings' was not found"))).toBe(false);
  });
});
