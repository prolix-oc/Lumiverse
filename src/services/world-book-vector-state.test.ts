import { describe, expect, test } from "bun:test";
import {
  desiredWorldBookVectorIndexStatus,
  isWorldBookEntryVectorEligible,
  isWorldBookEntryVectorSearchReady,
  worldBookVectorSettingsFingerprint,
  worldBookVectorTrackingFingerprint,
} from "./world-book-vector-state";

describe("world-book-vector-state", () => {
  test("derives pending only for entries that are currently indexable", () => {
    expect(desiredWorldBookVectorIndexStatus({
      vectorized: true,
      disabled: false,
      content: "Lore text",
    } as any)).toBe("pending");

    expect(desiredWorldBookVectorIndexStatus({
      vectorized: false,
      disabled: false,
      content: "Lore text",
    } as any)).toBe("not_enabled");

    expect(desiredWorldBookVectorIndexStatus({
      vectorized: true,
      disabled: true,
      content: "Lore text",
    } as any)).toBe("not_enabled");

    expect(desiredWorldBookVectorIndexStatus({
      vectorized: true,
      disabled: false,
      content: "   ",
    } as any)).toBe("not_enabled");
  });

  test("requires indexed state before vector retrieval can use an entry", () => {
    expect(isWorldBookEntryVectorEligible({
      vectorized: true,
      disabled: false,
      content: "Lore text",
    } as any)).toBe(true);

    expect(isWorldBookEntryVectorSearchReady({
      vectorized: true,
      disabled: false,
      content: "Lore text",
      vector_index_status: "indexed",
    } as any)).toBe(true);

    expect(isWorldBookEntryVectorSearchReady({
      vectorized: true,
      disabled: false,
      content: "Lore text",
      vector_index_status: "pending",
    } as any)).toBe(false);
  });

  test("entry tracking fingerprint changes when vector-relevant fields change", () => {
    const base = {
      world_book_id: "book-1",
      content: "Lore text",
      comment: "Title",
      key: ["alpha"],
      keysecondary: ["beta"],
      vectorized: true,
      disabled: false,
      updated_at: 100,
    };

    expect(worldBookVectorTrackingFingerprint({ ...base })).toBe(
      worldBookVectorTrackingFingerprint({ ...base }),
    );
    expect(worldBookVectorTrackingFingerprint({ ...base, content: "Different lore" })).not.toBe(
      worldBookVectorTrackingFingerprint({ ...base }),
    );
    expect(worldBookVectorTrackingFingerprint({ ...base, world_book_id: "book-2" })).not.toBe(
      worldBookVectorTrackingFingerprint({ ...base }),
    );
    expect(worldBookVectorTrackingFingerprint({ ...base, updated_at: 101 })).not.toBe(
      worldBookVectorTrackingFingerprint({ ...base }),
    );
  });

  test("settings fingerprint only tracks chunking fields that affect stored vectors", () => {
    const base = worldBookVectorSettingsFingerprint({
      chunkTargetTokens: 420,
      chunkMaxTokens: 700,
      chunkOverlapTokens: 80,
      maxChunksPerEntry: 8,
    });

    expect(base).toBe(worldBookVectorSettingsFingerprint({
      chunkTargetTokens: 420,
      chunkMaxTokens: 700,
      chunkOverlapTokens: 80,
      maxChunksPerEntry: 8,
    }));
    expect(base).not.toBe(worldBookVectorSettingsFingerprint({
      chunkTargetTokens: 421,
      chunkMaxTokens: 700,
      chunkOverlapTokens: 80,
      maxChunksPerEntry: 8,
    }));
  });
});
