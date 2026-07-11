import { afterEach, describe, expect, test } from "bun:test";

import type { WorldBookEntry } from "../types/world-book";
import type { EmbeddingConfigWithStatus } from "./embeddings.service";
import { __vectorWiCacheTest } from "./prompt-assembly.service";
import type { VectorStoreConfig } from "./vector-store-config.service";
import type { WorldBookVectorSettings } from "./world-book-vector-settings.service";
import type { VectorWorldInfoRetrievalResult } from "./world-info-vector-ranking";

function entry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: "entry-1",
    world_book_id: "book-1",
    uid: "uid-1",
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: ["alpha"],
    keysecondary: ["beta"],
    content: "old lore",
    comment: "Old lore",
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: false,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 100,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: false,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 10,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: true,
    vectorized: true,
    vector_index_status: "indexed",
    vector_indexed_at: 100,
    vector_index_error: null,
    extensions: { nested: { a: 1, b: 2 } },
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

interface FingerprintInput {
  userId: string;
  chatId: string;
  worldBookIds: string[];
  entries: WorldBookEntry[];
  queryText: string;
  embeddingConfig: EmbeddingConfigWithStatus;
  worldBookVectorSettings: WorldBookVectorSettings;
  vectorStoreConfig: VectorStoreConfig;
}

function fingerprintInput(): FingerprintInput {
  return {
    userId: "user-1",
    chatId: "chat-1",
    worldBookIds: ["book-1"],
    entries: [entry()],
    queryText: "where is alpha",
    embeddingConfig: {
      enabled: true,
      provider: "openai" as const,
      api_url: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 1536,
      send_dimensions: true,
      retrieval_top_k: 6,
      hybrid_weight_mode: "balanced" as const,
      preferred_context_size: 3,
      batch_size: 32,
      similarity_threshold: 0.8,
      rerank_cutoff: 0.1,
      vectorize_world_books: true,
      vectorize_chat_messages: false,
      vectorize_chat_documents: false,
      chat_memory_mode: "balanced" as const,
      request_timeout: 60,
      vertex_region: "global",
      has_api_key: true,
    },
    worldBookVectorSettings: {
      presetMode: "balanced" as const,
      chunkTargetTokens: 420,
      chunkMaxTokens: 700,
      chunkOverlapTokens: 80,
      retrievalTopK: 6,
      maxChunksPerEntry: 8,
    },
    vectorStoreConfig: { provider: "lancedb" as const },
  };
}

function retrievalResult(): VectorWorldInfoRetrievalResult {
  return {
    entries: [{
      entry: entry(),
      score: 1,
      distance: 0,
      finalScore: 1,
      lexicalCandidateScore: null,
      matchedPrimaryKeys: ["alpha"],
      matchedSecondaryKeys: [],
      matchedComment: "Old lore",
      scoreBreakdown: {
        vectorSimilarity: 1,
        lexicalContentBoost: 0,
        primaryExact: 0,
        primaryPartial: 0,
        secondaryExact: 0,
        secondaryPartial: 0,
        commentExact: 0,
        commentPartial: 0,
        focusBoost: 0,
        priority: 0,
        broadPenalty: 0,
        focusMissPenalty: 0,
      },
      searchTextPreview: "old lore",
    }],
    candidateTrace: [],
    queryPreview: "where is alpha",
    eligibleCount: 1,
    hitsBeforeThreshold: 1,
    hitsAfterThreshold: 1,
    thresholdRejected: 0,
    hitsAfterRerankCutoff: 1,
    rerankRejected: 0,
    topK: 1,
    cap: 1,
    blockerMessages: ["original"],
    timingsMs: {
      queryBuildMs: 1,
      queryEmbedMs: 1,
      searchMs: 1,
      rankingMs: 1,
      totalMs: 4,
    },
  };
}

afterEach(() => __vectorWiCacheTest.clear());

describe("vector world-info retrieval cache", () => {
  test("fingerprints same-length lore edits and retrieval-affecting state", () => {
    const base = fingerprintInput();
    const baseFingerprint = __vectorWiCacheTest.buildFingerprint(base);
    const mutations: Array<(input: ReturnType<typeof fingerprintInput>) => void> = [
      (input) => { input.entries[0].content = "new lore"; },
      (input) => { input.entries[0].key = ["gamma"]; },
      (input) => { input.entries[0].comment = "New lore"; },
      (input) => { input.entries[0].priority = 11; },
      (input) => { input.entries[0].group_name = "group"; },
      (input) => { input.entries[0].group_override = true; },
      (input) => { input.entries[0].group_weight = 50; },
      (input) => { input.entries[0].position = 2; },
      (input) => { input.entries[0].vector_index_status = "pending"; },
      (input) => { input.entries[0].vector_indexed_at = 101; },
      (input) => { input.embeddingConfig.model = "text-embedding-3-large"; },
      (input) => { input.embeddingConfig.provider = "openrouter"; },
      (input) => { input.embeddingConfig.has_api_key = false; },
      (input) => { input.vectorStoreConfig = { provider: "milvus", milvus: { address: "127.0.0.1:19530" } }; },
      (input) => { input.worldBookVectorSettings.chunkTargetTokens = 421; },
    ];

    for (const mutate of mutations) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(__vectorWiCacheTest.buildFingerprint(changed)).not.toBe(baseFingerprint);
    }
  });

  test("uses stable object-key ordering while tracking extension changes", () => {
    const first = fingerprintInput();
    first.entries[0].extensions = { z: 3, nested: { b: 2, a: 1 } };
    const second = fingerprintInput();
    second.entries[0].extensions = { nested: { a: 1, b: 2 }, z: 3 };

    expect(__vectorWiCacheTest.buildFingerprint(first)).toBe(
      __vectorWiCacheTest.buildFingerprint(second),
    );

    second.entries[0].extensions.nested.b = 4;
    expect(__vectorWiCacheTest.buildFingerprint(first)).not.toBe(
      __vectorWiCacheTest.buildFingerprint(second),
    );
  });

  test("normalizes book and entry ordering for equivalent snapshots", () => {
    const first = fingerprintInput();
    first.worldBookIds = ["book-2", "book-1"];
    first.entries = [
      entry({ id: "entry-2", world_book_id: "book-2" }),
      entry({ id: "entry-1", world_book_id: "book-1" }),
    ];
    const second = fingerprintInput();
    second.worldBookIds = ["book-1", "book-2"];
    second.entries = [...first.entries].reverse();

    expect(__vectorWiCacheTest.buildFingerprint(first)).toBe(
      __vectorWiCacheTest.buildFingerprint(second),
    );
  });

  test("isolates stored and returned object graphs", () => {
    const original = retrievalResult();
    __vectorWiCacheTest.set("key", original);

    original.blockerMessages[0] = "mutated original";
    original.entries[0].entry.content = "mutated original lore";

    const firstHit = __vectorWiCacheTest.get("key");
    expect(firstHit?.blockerMessages).toEqual(["original"]);
    expect(firstHit?.entries[0].entry.content).toBe("old lore");

    firstHit!.blockerMessages[0] = "mutated hit";
    firstHit!.entries[0].entry.content = "mutated hit lore";
    firstHit!.entries[0].matchedPrimaryKeys.push("extra");

    const secondHit = __vectorWiCacheTest.get("key");
    expect(secondHit?.blockerMessages).toEqual(["original"]);
    expect(secondHit?.entries[0].entry.content).toBe("old lore");
    expect(secondHit?.entries[0].matchedPrimaryKeys).toEqual(["alpha"]);
  });
});
