import { describe, expect, it } from "bun:test";
import { canUseChatChunkVectorizationSubprocess } from "./chat-chunk-vectorization-client";

describe("canUseChatChunkVectorizationSubprocess", () => {
  it("defaults to enabled on non-Windows runtimes", () => {
    expect(canUseChatChunkVectorizationSubprocess("linux", {})).toBe(true);
  });

  it("turns off only when explicitly set to false", () => {
    expect(canUseChatChunkVectorizationSubprocess("linux", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "false",
    })).toBe(false);
    expect(canUseChatChunkVectorizationSubprocess("linux", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "true",
    })).toBe(true);
  });

  it("disables the subprocess on Windows by default", () => {
    expect(canUseChatChunkVectorizationSubprocess("win32", {})).toBe(false);
  });

  it("allows an explicit Windows subprocess override", () => {
    expect(canUseChatChunkVectorizationSubprocess("win32", {
      LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS: "true",
    })).toBe(true);
  });
});
