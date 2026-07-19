import { describe, expect, test } from "bun:test";

import { eq } from "../addressing";
import type { HybridSearchOptions, VectorHit } from "../types";
import { MilvusStore } from "./milvus";

describe("MilvusStore.hybridSearch", () => {
  test("keeps RRF ordering but returns cosine similarity instead of the fused score", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    let hybridRequest: any = null;
    (store as any).getClient = async () => ({
      hybridSearch: async (request: any) => {
        hybridRequest = request;
        return {
          results: [
            {
              id: "row-identical",
              source_id: "entry-identical",
              content: "identical",
              metadata_json: "{}",
              score: 0.0325,
              vector: [2, 0],
            },
            {
              id: "row-orthogonal",
              source_id: "entry-orthogonal",
              content: "orthogonal",
              metadata_json: "{}",
              score: 0.032,
              vector: [0, 3],
            },
          ],
        };
      },
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 2,
      withVector: false,
    });

    expect(hits.map((hit) => hit.source_id)).toEqual([
      "entry-identical",
      "entry-orthogonal",
    ]);
    expect(hits.map((hit) => hit.similarity)).toEqual([1, 0]);
    expect(hits.every((hit) => hit.similarity !== 0.0325 && hit.similarity !== 0.032)).toBe(true);
    expect(hits.every((hit) => hit.vector === null)).toBe(true);
    expect(hybridRequest.output_fields).toContain("vector");
  });

  test("retains calibrated vectors when requested", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    (store as any).getClient = async () => ({
      hybridSearch: async () => ({
        results: [{
          id: "row-1",
          source_id: "entry-1",
          content: "content",
          metadata_json: "{}",
          score: 0.032,
          vector: [1, 0],
        }],
      }),
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 1,
      withVector: true,
    });

    expect(hits[0]?.similarity).toBe(1);
    expect(hits[0]?.vector).toEqual([1, 0]);
  });

  test("bounded dense fallback rescales missing vectors and leaves unresolved hits unknown", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    (store as any).getClient = async () => ({
      hybridSearch: async () => ({
        results: [
          { id: "row-missing", source_id: "entry-missing", content: "missing", metadata_json: "{}", score: 0.032 },
          { id: "row-invalid", source_id: "entry-invalid", content: "invalid", metadata_json: "{}", score: 0.031, vector: [1] },
        ],
      }),
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};
    const rescoreOptions: HybridSearchOptions[] = [];
    (store as any).vectorSearch = async (options: HybridSearchOptions) => {
      rescoreOptions.push(options);
      return [{
        id: "row-missing",
        source_id: "entry-missing",
        content: "missing",
        metadata_json: "{}",
        similarity: 0.75,
        lexicalScore: null,
        vector: null,
      } satisfies VectorHit];
    };

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 2,
      withVector: false,
    });

    expect(hits.map((hit) => hit.source_id)).toEqual(["entry-missing", "entry-invalid"]);
    expect(hits.map((hit) => hit.similarity)).toEqual([0.75, null]);
    expect(rescoreOptions[0]?.limit).toBe(2);
    expect(rescoreOptions[0]?.filter).toEqual({
      op: "and",
      clauses: [
        eq("user_id", "user-1"),
        { op: "in", field: "id", values: ["row-missing", "row-invalid"] },
      ],
    });
  });

  test("falls back to app-side fusion and bypasses native hybrid after a zero-row anomaly", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };

    let hybridCalls = 0;
    let vectorCalls = 0;
    let lexicalCalls = 0;

    const denseHit: VectorHit = {
      id: "dense-1",
      source_id: "entry-1",
      content: "dense",
      metadata_json: "{}",
      similarity: 0.92,
      lexicalScore: null,
      vector: null,
    };
    const lexicalHit: VectorHit = {
      id: "lex-1",
      source_id: "entry-1",
      content: "lexical",
      metadata_json: "{}",
      similarity: null,
      lexicalScore: 12,
      vector: null,
    };

    (store as any).getClient = async () => ({
      hybridSearch: async () => {
        hybridCalls += 1;
        return { results: [] };
      },
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};
    (store as any).vectorSearch = async (_opts: HybridSearchOptions) => {
      vectorCalls += 1;
      return [denseHit];
    };
    (store as any).lexicalSearch = async (_opts: HybridSearchOptions) => {
      lexicalCalls += 1;
      return [lexicalHit];
    };

    const opts: HybridSearchOptions = {
      collection: "embeddings_world_books",
      vector: [0.1, 0.2, 0.3],
      queryText: "where is the sword",
      filter: eq("user_id", "user-1"),
      limit: 8,
      withVector: false,
    };

    const first = await store.hybridSearch(opts);
    expect(first).toHaveLength(1);
    expect(first[0]?.source_id).toBe("entry-1");
    expect(hybridCalls).toBe(1);
    expect(vectorCalls).toBe(1);
    expect(lexicalCalls).toBe(1);

    const second = await store.hybridSearch(opts);
    expect(second).toHaveLength(1);
    expect(hybridCalls).toBe(1);
    expect(vectorCalls).toBe(2);
    expect(lexicalCalls).toBe(2);
  });
});
