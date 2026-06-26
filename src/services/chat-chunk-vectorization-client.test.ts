import { afterEach, describe, expect, it } from "bun:test";
import { canUseChatChunkVectorizationSubprocess } from "./chat-chunk-vectorization-client";

const ORIGINAL_ENV = process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS;

afterEach(() => {
  if (typeof ORIGINAL_ENV === "undefined") {
    delete process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS;
    return;
  }
  process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS = ORIGINAL_ENV;
});

describe("canUseChatChunkVectorizationSubprocess", () => {
  it("defaults to enabled", () => {
    delete process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS;
    expect(canUseChatChunkVectorizationSubprocess()).toBe(true);
  });

  it("turns off only when explicitly set to false", () => {
    process.env.LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS = "false";
    expect(canUseChatChunkVectorizationSubprocess()).toBe(false);
  });
});
