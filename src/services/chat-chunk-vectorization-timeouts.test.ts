import { describe, expect, it } from "bun:test";
import {
  CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_ERROR_NAME,
  createChatChunkVectorizationBatchTimeoutError,
  isChatChunkVectorizationBatchTimeoutError,
} from "./chat-chunk-vectorization-timeouts";

describe("chat chunk vectorization timeout helpers", () => {
  it("stamps cooperative timeout errors with a stable name and message", () => {
    const err = createChatChunkVectorizationBatchTimeoutError(90_000);

    expect(err.name).toBe(CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_ERROR_NAME);
    expect(err.message).toBe("Chat chunk vectorization batch timed out after 90s");
  });

  it("only matches the named cooperative timeout error", () => {
    const err = createChatChunkVectorizationBatchTimeoutError();
    const generic = new Error(err.message);

    expect(isChatChunkVectorizationBatchTimeoutError(err)).toBe(true);
    expect(isChatChunkVectorizationBatchTimeoutError(generic)).toBe(false);
  });
});
