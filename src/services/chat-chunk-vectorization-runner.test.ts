import { describe, expect, it } from "bun:test";
import { processChatChunkVectorizationBatch } from "./chat-chunk-vectorization-runner";

describe("processChatChunkVectorizationBatch", () => {
  it("returns an empty result for an empty task list", async () => {
    await expect(processChatChunkVectorizationBatch([])).resolves.toEqual({
      refreshedChatIds: [],
      failedChunkIds: [],
      processedCount: 0,
    });
  });
});
