import { describe, expect, test } from "bun:test";

import { __test__ } from "./embeddings.service";
import { eq } from "./vector-store/addressing";
import type { VectorHit } from "./vector-store/types";

function hit(sourceId: string, similarity: number, id = `${sourceId}-${similarity}`): VectorHit {
  return {
    id,
    source_id: sourceId,
    content: id,
    metadata_json: "{}",
    similarity,
    lexicalScore: null,
    vector: null,
  };
}

describe("world-book unique-source search", () => {
  test("continues past monopolizing chunks until the unique-entry target is met", async () => {
    const calls: string[][] = [];
    const batches = [
      [hit("entry-a", 0.99, "a-1"), hit("entry-a", 0.98, "a-2")],
      [hit("entry-b", 0.9, "b-1"), hit("entry-b", 0.8, "b-2")],
      [hit("entry-c", 0.7, "c-1")],
    ];

    const rows = await __test__.collectWorldBookHitsByUniqueSource(
      eq("owner_id", "book"),
      3,
      async (filter) => {
        const excluded = filter.op === "and"
          ? filter.clauses.flatMap((clause) => clause.op === "nin" ? clause.values.map(String) : [])
          : [];
        calls.push(excluded);
        return batches[calls.length - 1] ?? [];
      },
    );

    expect(calls).toEqual([[], ["entry-a"], ["entry-a", "entry-b"]]);
    const collapsed = __test__.collapseWorldBookHitsBySource(rows, "similarity")
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    expect(collapsed.map((row) => row.id)).toEqual(["a-1", "b-1", "c-1"]);
  });

  test("stops when a provider ignores source exclusions", async () => {
    let calls = 0;
    const rows = await __test__.collectWorldBookHitsByUniqueSource(
      eq("owner_id", "book"),
      3,
      async () => {
        calls += 1;
        return [hit("entry-a", 0.9)];
      },
    );

    expect(calls).toBe(2);
    expect(new Set(rows.map((row) => row.source_id))).toEqual(new Set(["entry-a"]));
  });

  test("honors cancellation between provider batches", async () => {
    const controller = new AbortController();
    let calls = 0;
    const rows = await __test__.collectWorldBookHitsByUniqueSource(
      eq("owner_id", "book"),
      3,
      async () => {
        calls += 1;
        controller.abort();
        return [hit("entry-a", 0.9)];
      },
      controller.signal,
    );

    expect(calls).toBe(1);
    expect(rows).toEqual([]);
  });

  test("chunks large exclusion sets at the provider filter limit", () => {
    const filters = __test__.worldBookSourceExclusionFilters(
      new Set(Array.from({ length: 501 }, (_, index) => `entry-${index}`)),
    );

    expect(filters).toHaveLength(3);
    expect(filters.map((filter) => filter.op === "nin" ? filter.values.length : 0)).toEqual([250, 250, 1]);
  });
});
