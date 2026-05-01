import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WORLD_BOOK_VECTOR_SETTINGS,
  normalizeWorldBookVectorSettings,
} from "./world-book-vector-settings.service";

describe("normalizeWorldBookVectorSettings", () => {
  it("applies preset values when preset mode is selected", () => {
    const settings = normalizeWorldBookVectorSettings({
      presetMode: "lean",
      chunkTargetTokens: 999,
      retrievalTopK: 20,
    });

    expect(settings.presetMode).toBe("lean");
    expect(settings.chunkTargetTokens).toBe(220);
    expect(settings.chunkMaxTokens).toBe(360);
    expect(settings.retrievalTopK).toBe(4);
    expect(settings.maxChunksPerEntry).toBe(4);
  });

  it("preserves manual values in custom mode", () => {
    const settings = normalizeWorldBookVectorSettings({
      presetMode: "custom",
      chunkTargetTokens: 333,
      chunkMaxTokens: 777,
      chunkOverlapTokens: 55,
      retrievalTopK: 7,
      maxChunksPerEntry: 9,
    });

    expect(settings).toEqual({
      presetMode: "custom",
      chunkTargetTokens: 333,
      chunkMaxTokens: 777,
      chunkOverlapTokens: 55,
      retrievalTopK: 7,
      maxChunksPerEntry: 9,
    });
  });

  it("uses the provided retrieval fallback in custom mode when unset", () => {
    const settings = normalizeWorldBookVectorSettings({
      presetMode: "custom",
    }, {
      retrievalTopK: 5,
    });

    expect(settings.presetMode).toBe("custom");
    expect(settings.retrievalTopK).toBe(5);
    expect(settings.chunkTargetTokens).toBe(DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.chunkTargetTokens);
  });

  it("uses the provided retrieval fallback in preset mode", () => {
    const settings = normalizeWorldBookVectorSettings({
      presetMode: "balanced",
    }, {
      retrievalTopK: 5,
    });

    expect(settings.presetMode).toBe("balanced");
    expect(settings.retrievalTopK).toBe(5);
    expect(settings.chunkTargetTokens).toBe(420);
  });
});
