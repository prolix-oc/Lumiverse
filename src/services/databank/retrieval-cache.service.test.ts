import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearCache,
  getCachedDatabankResult,
  invalidateDatabankCache,
  resetDatabankCacheForTests,
  setCachedDatabankResult,
} from "./retrieval-cache.service";
import type { DatabankRetrievalResult } from "./types";

const result: DatabankRetrievalResult = {
  chunks: [],
  formatted: "cached content",
  count: 1,
};

beforeEach(() => resetDatabankCacheForTests());

describe("databank retrieval cache invalidation", () => {
  test("invalidates every chat query containing a mutated databank", () => {
    setCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query one", 4, result);
    setCachedDatabankResult("user-1", "chat-2", ["bank-a", "bank-b"], "query two", 4, result);
    setCachedDatabankResult("user-1", "chat-1", ["bank-b"], "query one", 4, result);
    setCachedDatabankResult("user-2", "chat-1", ["bank-a"], "query one", 4, result);

    invalidateDatabankCache("user-1", "bank-a");

    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query one", 4)).toBeNull();
    expect(getCachedDatabankResult("user-1", "chat-2", ["bank-a", "bank-b"], "query two", 4)).toBeNull();
    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-b"], "query one", 4)).toBe(result);
    expect(getCachedDatabankResult("user-2", "chat-1", ["bank-a"], "query one", 4)).toBe(result);
  });

  test("chat clearing remains scoped to one user and chat", () => {
    setCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query", 4, result);
    setCachedDatabankResult("user-1", "chat-2", ["bank-a"], "query", 4, result);

    clearCache("user-1", "chat-1");

    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query", 4)).toBeNull();
    expect(getCachedDatabankResult("user-1", "chat-2", ["bank-a"], "query", 4)).toBe(result);
  });

  test("evicts the least recently used result at the cache limit", () => {
    for (let i = 0; i < 256; i += 1) {
      setCachedDatabankResult("user-1", "chat-1", ["bank-a"], `query-${i}`, 4, result);
    }

    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query-0", 4)).toBe(result);
    setCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query-256", 4, result);

    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query-0", 4)).toBe(result);
    expect(getCachedDatabankResult("user-1", "chat-1", ["bank-a"], "query-1", 4)).toBeNull();
  });
});
