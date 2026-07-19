import { describe, expect, test } from "bun:test";
import {
  buildChatChunkEmbeddingSlices,
  collapseVectorHitsBySourceId,
  hashChatChunkContent,
  splitChatChunkContent,
} from "./chat-chunk-embedding";

describe("splitChatChunkContent", () => {
  test("bisects long unbroken content when semantic chunking cannot", () => {
    const text = "x".repeat(3200);
    const parts = splitChatChunkContent(text, { forceSplit: true });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length < text.length)).toBe(true);
    expect(parts.join("")).toBe(text);
  });
});

describe("buildChatChunkEmbeddingSlices", () => {
  test("stamps stable source metadata across split rows", () => {
    const content = Array.from(
      { length: 8 },
      (_, i) => `[USER | Alice]: message ${i} ${"word ".repeat(120)}`,
    ).join("\n");

    const slices = buildChatChunkEmbeddingSlices(
      content,
      { chunkId: "chunk-1", messageIds: ["m1", "m2"] },
      { forceSplit: true },
    );

    expect(slices.length).toBeGreaterThan(1);
    expect(new Set(slices.map((slice) => slice.metadata.sourceContentHash))).toEqual(
      new Set([hashChatChunkContent(content)]),
    );
    expect(new Set(slices.map((slice) => slice.metadata.splitCount))).toEqual(
      new Set([slices.length]),
    );
    expect(slices.map((slice) => slice.metadata.splitIndex)).toEqual(
      slices.map((_, index) => index),
    );
  });
});

describe("collapseVectorHitsBySourceId", () => {
  test("keeps the strongest similarity hit per logical chunk and preserves lexical score", () => {
    const collapsed = collapseVectorHitsBySourceId([
      {
        id: "u:chat_chunk:c1:0",
        source_id: "c1",
        content: "first half",
        metadata_json: "{\"splitIndex\":0}",
        similarity: 0.72,
        lexicalScore: null,
        vector: null,
      },
      {
        id: "u:chat_chunk:c1:1",
        source_id: "c1",
        content: "second half",
        metadata_json: "{\"splitIndex\":1}",
        similarity: 0.91,
        lexicalScore: 4.5,
        vector: null,
      },
      {
        id: "u:chat_chunk:c2:0",
        source_id: "c2",
        content: "other chunk",
        metadata_json: "{}",
        similarity: 0.88,
        lexicalScore: 2.1,
        vector: null,
      },
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({
      source_id: "c1",
      content: "second half",
      similarity: 0.91,
      lexicalScore: 4.5,
    });
  });
});
