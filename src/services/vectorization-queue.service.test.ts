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
