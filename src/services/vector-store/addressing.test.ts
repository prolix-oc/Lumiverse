import { describe, expect, it } from "bun:test";
import {
  MAX_SOURCE_FILTER_IDS,
  andFilter,
  collectionForSourceType,
  cosineSimilarity,
  distanceFromSimilarity,
  mmrSelect,
  ownerScope,
  reciprocalRankFusion,
  rowId,
  selectCollection,
  sourceIdsIn,
  sourceIdsNotIn,
  toSimilarity,
} from "./addressing";
import type { VectorHit } from "./types";

describe("rowId", () => {
  it("composes the canonical id", () => {
    expect(rowId("u1", "chat_chunk", "c9", 0)).toBe("u1:chat_chunk:c9:0");
  });
});

describe("collection selection", () => {
  it("routes world-book entries to their dedicated collection", () => {
    expect(collectionForSourceType("world_book_entry")).toBe("embeddings_world_books");
    expect(collectionForSourceType("chat_chunk")).toBe("embeddings");
    expect(selectCollection([{ source_type: "world_book_entry" }])).toBe("embeddings_world_books");
    expect(selectCollection([{ source_type: "world_book_entry" }, { source_type: "chat_chunk" }])).toBe("embeddings");
    expect(selectCollection([])).toBe("embeddings");
  });
});

describe("score normalization (the single seam)", () => {
  it("maps LanceDB cosine distance to similarity and back without changing order", () => {
    const distances = [0.05, 0.2, 0.5, 0.9, 1.3];
    const sims = distances.map((d) => toSimilarity(d, "cosine_distance"));
    // Higher similarity for lower distance.
    expect(sims[0]).toBeGreaterThan(sims[1]);
    // Round-trip rebuilds the distance for the public contract; order preserved.
    const back = sims.map((s) => distanceFromSimilarity(s));
    for (let i = 0; i < distances.length; i++) {
      expect(back[i]).toBeCloseTo(distances[i], 10);
    }
  });

  it("passes through provider similarity and maps it onto the [0,2] distance scale", () => {
    expect(toSimilarity(0.8, "cosine_similarity")).toBe(0.8);
    expect(distanceFromSimilarity(0.8)).toBeCloseTo(0.2, 10); // similarity 0.8 -> distance 0.2
    expect(distanceFromSimilarity(-1)).toBeCloseTo(2, 10); // worst cosine sim -> max distance
  });

  it("sends lexical-only hits (no vector distance) to +Infinity so they sort last", () => {
    expect(distanceFromSimilarity(null)).toBe(Number.POSITIVE_INFINITY);
  });
});

function hit(source_id: string, over: Partial<VectorHit> = {}): VectorHit {
  return {
    id: source_id,
    source_id,
    content: source_id,
    metadata_json: "{}",
    similarity: null,
    lexicalScore: null,
    vector: null,
    ...over,
  };
}

describe("reciprocalRankFusion", () => {
  it("short-circuits when a leg is empty (free graceful degradation)", () => {
    const v = [hit("a"), hit("b")];
    expect(reciprocalRankFusion(v, [])).toBe(v);
    const l = [hit("x")];
    expect(reciprocalRankFusion([], l)).toBe(l);
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("ranks items appearing in both legs above single-leg items", () => {
    const vector = [hit("a", { similarity: 0.9 }), hit("b", { similarity: 0.8 }), hit("c", { similarity: 0.7 })];
    const lexical = [hit("c", { lexicalScore: 5 }), hit("d", { lexicalScore: 4 })];
    const fused = reciprocalRankFusion(vector, lexical);
    // c is in both legs -> highest fused score.
    expect(fused[0].source_id).toBe("c");
    // The kept hit carries the vector-leg similarity AND the lexical score.
    expect(fused[0].similarity).toBe(0.7);
    expect(fused[0].lexicalScore).toBe(5);
    expect(fused.map((h) => h.source_id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("mmrSelect", () => {
  it("returns top-k by input order when too few have vectors", () => {
    const cands = [hit("a", { similarity: 0.9 }), hit("b", { similarity: 0.8 })];
    expect(mmrSelect(cands, [], 5).map((h) => h.source_id)).toEqual(["a", "b"]);
  });

  it("favors a relevant + diverse pick over a near-duplicate of the first", () => {
    const cands: VectorHit[] = [
      hit("a", { similarity: 0.95, vector: [1, 0, 0] }),
      hit("dup", { similarity: 0.94, vector: [1, 0, 0] }), // near-identical to a
      hit("div", { similarity: 0.8, vector: [0, 1, 0] }), // orthogonal -> diverse
    ];
    const picked = mmrSelect(cands, [], 2, 0.7).map((h) => h.source_id);
    expect(picked[0]).toBe("a");
    expect(picked[1]).toBe("div"); // diversity beats the marginally-more-relevant duplicate
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, and 0 for length mismatch", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("filter builders + cardinality cap", () => {
  it("builds the universal owner scope", () => {
    expect(ownerScope("u1", "chat_chunk", "chat9")).toEqual({
      op: "and",
      clauses: [
        { op: "eq", field: "user_id", value: "u1" },
        { op: "eq", field: "source_type", value: "chat_chunk" },
        { op: "eq", field: "owner_id", value: "chat9" },
      ],
    });
  });

  it("inlines source-id sets under the cap and DROPS them over it", () => {
    expect(sourceIdsIn(["a", "b"])).toEqual({ op: "in", field: "source_id", values: ["a", "b"] });
    expect(sourceIdsIn([])).toBeNull();
    const tooMany = Array.from({ length: MAX_SOURCE_FILTER_IDS + 1 }, (_, i) => `id${i}`);
    expect(sourceIdsIn(tooMany)).toBeNull(); // over cap -> caller widens + post-filters
    expect(sourceIdsNotIn(tooMany)).toBeNull();
  });

  it("collapses a single surviving clause and drops nulls in andFilter", () => {
    const only = andFilter([null, { op: "eq", field: "user_id", value: "u1" }, undefined]);
    expect(only).toEqual({ op: "eq", field: "user_id", value: "u1" });
    expect(andFilter([])).toEqual({ op: "and", clauses: [] });
  });
});
