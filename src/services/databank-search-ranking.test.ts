import { describe, expect, it } from "bun:test";
import { mapDatabankSearchHits } from "./embeddings.service";
import { databankCacheKey } from "./databank/retrieval.service";
import type { VectorHit } from "./vector-store/types";

function hit(sourceId: string, similarity: number | null, documentId?: string): VectorHit {
  return {
    id: sourceId,
    source_id: sourceId,
    content: `content:${sourceId}`,
    metadata_json: JSON.stringify({ sourceId, ...(documentId ? { documentId } : {}) }),
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

  it("uses the top result from each document before returning additional chunks", () => {
    const results = mapDatabankSearchHits([
      hit("document-a-0", 0.98, "document-a"),
      hit("document-a-1", 0.97, "document-a"),
      hit("document-b-0", 0.82, "document-b"),
      hit("document-a-2", 0.79, "document-a"),
      hit("document-c-0", 0.71, "document-c"),
    ], 4);

    expect(results.map((result) => result.chunk_id)).toEqual([
      "document-a-0",
      "document-b-0",
      "document-c-0",
      "document-a-1",
    ]);
  });

  it("falls back to provider order after every available document is represented", () => {
    const results = mapDatabankSearchHits([
      hit("document-a-0", 0.98, "document-a"),
      hit("document-a-1", 0.97, "document-a"),
      hit("document-b-0", 0.82, "document-b"),
      hit("document-a-2", 0.79, "document-a"),
    ], 4);

    expect(results.map((result) => result.chunk_id)).toEqual([
      "document-a-0",
      "document-b-0",
      "document-a-1",
      "document-a-2",
    ]);
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
