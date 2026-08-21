import { describe, expect, test } from "bun:test";
import { collectAll, parsePagination } from "./pagination";
import { MAX_LIMIT } from "../types/pagination";

function pagedStore<T>(items: T[]) {
  const calls: Array<{ limit: number; offset: number }> = [];
  const fetchPage = (pagination: { limit: number; offset: number }) => {
    calls.push(pagination);
    const { limit, offset } = pagination;
    return {
      data: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  };
  return { calls, fetchPage };
}

describe("collectAll", () => {
  test("collects every page past the per-request row cap", () => {
    const items = Array.from({ length: 2500 }, (_, i) => `script-${i}`);
    const { calls, fetchPage } = pagedStore(items);

    const result = collectAll(fetchPage, 1000);

    expect(calls).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ]);
    expect(result.data).toEqual(items);
    expect(result.total).toBe(2500);
  });

  test("stops after one page when everything fits", () => {
    const { calls, fetchPage } = pagedStore(["a", "b", "c"]);

    const result = collectAll(fetchPage, 1000);

    expect(calls).toEqual([{ limit: 1000, offset: 0 }]);
    expect(result.data).toEqual(["a", "b", "c"]);
  });

  test("rethrows a first-page failure but keeps pages already collected on a later failure", () => {
    const boom = new Error("db unavailable");

    expect(() =>
      collectAll(() => {
        throw boom;
      })
    ).toThrow(boom);

    let call = 0;
    const result = collectAll(() => {
      if (call === 0) {
        call++;
        return { data: ["kept"], total: 5000, limit: 200, offset: 0 };
      }
      throw boom;
    });
    expect(result.data).toEqual(["kept"]);
  });

  test("handles an empty list without looping", () => {
    const { calls, fetchPage } = pagedStore([]);

    const result = collectAll(fetchPage);

    expect(calls).toEqual([{ limit: 200, offset: 0 }]);
    expect(result.data).toEqual([]);
  });
});

describe("parsePagination", () => {
  test("clamps limit to the server-side MAX_LIMIT", () => {
    expect(parsePagination("5000")).toEqual({ limit: MAX_LIMIT, offset: 0 });
    expect(parsePagination("0")).toEqual({ limit: 1, offset: 0 });
  });
});
