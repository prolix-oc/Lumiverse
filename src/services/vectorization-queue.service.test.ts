import { describe, expect, test } from "bun:test";
import { __test__ } from "./vectorization-queue.service";

function job(overrides: Record<string, unknown> = {}) {
  return {
    type: "world_book_entry" as const,
    priority: 2,
    userId: "user",
    chatId: "",
    worldBookEntryId: "entry-1",
    supersedesIndexed: false,
    queuedAt: 1,
    ...overrides,
  };
}

describe("world-book vectorization queue supersession", () => {
  test("processes mutation replacements even when a stale job wrote indexed", () => {
    const indexedRow = { vectorized: 1, disabled: 0, content: "lore", vector_index_status: "indexed" };
    expect(__test__.shouldProcessWorldBookVectorizationJob(indexedRow, job())).toBe(false);
    expect(__test__.shouldProcessWorldBookVectorizationJob(
      indexedRow,
      job({ supersedesIndexed: true }),
    )).toBe(true);
    expect(__test__.shouldProcessWorldBookVectorizationJob(
      { ...indexedRow, vector_index_status: "pending" },
      job(),
    )).toBe(true);
  });

  test("deduplication keeps the highest priority and superseding intent", () => {
    const existing = job({ priority: 3 });
    __test__.mergeVectorizationJobs(existing, job({ priority: 7, supersedesIndexed: true }));
    __test__.mergeVectorizationJobs(existing, job({ priority: 1, supersedesIndexed: false }));

    expect(existing.priority).toBe(7);
    expect(existing.supersedesIndexed).toBe(true);
  });
});

describe("world-book vectorization settle window", () => {
  test("holds recent lorebook jobs until the settle window expires", () => {
    const now = 10_000;
    const recent = [job({ queuedAt: now - 200 })];
    expect(__test__.worldBookJobsHaveSettled(recent, now)).toBe(false);
    expect(__test__.nextProcessDelayMs(recent, now)).toBe(__test__.WORLD_BOOK_VECTOR_SETTLE_MS - 200);
  });

  test("releases lorebook jobs after the settle window", () => {
    const now = 20_000;
    const settled = [job({ queuedAt: now - __test__.WORLD_BOOK_VECTOR_SETTLE_MS })];
    expect(__test__.worldBookJobsHaveSettled(settled, now)).toBe(true);
    expect(__test__.nextProcessDelayMs(settled, now)).toBe(100);
  });

  test("caps a long typing burst so one Lance write eventually proceeds", () => {
    const queuedAt = 1;
    const now = queuedAt + __test__.WORLD_BOOK_VECTOR_MAX_WAIT_MS;
    const burst = [job({ queuedAt })];
    expect(__test__.remainingWorldBookSettleMs(queuedAt, now)).toBe(0);
    expect(__test__.worldBookJobsHaveSettled(burst, now)).toBe(true);
    expect(__test__.nextProcessDelayMs(burst, now)).toBe(100);
  });
});
