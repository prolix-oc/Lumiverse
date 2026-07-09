import { describe, expect, it } from "bun:test";
import { mapDatabankSearchHits } from "./embeddings.service";
import { databankCacheKey } from "./databank/retrieval.service";
import type { VectorHit } from "./vector-store/types";

function hit(sourceId: string, similarity: number | null): VectorHit {
  return {
    id: sourceId,
    source_id: sourceId,
    content: `content:${sourceId}`,
    metadata_json: JSON.stringify({ sourceId }),
    similarity,
    lexicalScore: similarity == null ? 10 : null,
    vector: null,
  };
}

describe("databank search result mapping", () => {
  it("preserves hybrid ranking instead of re-sorting by vector score", () => {
    const results = mapDatabankSearchHits([
      hit("hybrid-winner", 0.42),
      hit("vector-runner-up", 0.91),
      hit("third", 0.7),
    ], 2);

    expect(results.map((result) => result.chunk_id)).toEqual([
      "hybrid-winner",
      "vector-runner-up",
    ]);
  });

  it("reports lexical-only hits without a fake perfect score", () => {
    const [result] = mapDatabankSearchHits([hit("lexical-only", null)], 1);

    expect(result.score).toBeNull();
  });
});

describe("databank retrieval cache identity", () => {
  it("varies by query and active databanks but not databank ordering", () => {
    const base = databankCacheKey("user", "chat", ["bank-b", "bank-a"], "query one", 4);

    expect(databankCacheKey("user", "chat", ["bank-a", "bank-b"], "query one", 4)).toBe(base);
    expect(databankCacheKey("user", "chat", ["bank-a", "bank-b"], "query two", 4)).not.toBe(base);
    expect(databankCacheKey("user", "chat", ["bank-a"], "query one", 4)).not.toBe(base);
  });
});
