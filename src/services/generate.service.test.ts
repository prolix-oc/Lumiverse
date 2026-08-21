import { describe, expect, test } from "bun:test";

import { __test__ } from "./generate.service";

// Provider-specific caching behavior lives in src/services/caching/ — see the
// dedicated tests in that directory. This file covers the residual non-caching
// flags that `injectConnectionMetadataFlags` still owns.

describe("injectConnectionMetadataFlags", () => {
  test("sets use_responses_api when metadata flag is true", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: { use_responses_api: true } },
      params,
    );
    expect(params.use_responses_api).toBe(true);
  });

  test("does not set use_responses_api when metadata flag is missing", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: {} },
      params,
    );
    expect(params.use_responses_api).toBeUndefined();
  });

  test("forwards openrouter metadata into _openrouter when set", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      {
        provider: "openrouter",
        metadata: { openrouter: { provider: { sort: "throughput" } } },
      },
      params,
    );
    expect(params._openrouter).toEqual({ provider: { sort: "throughput" } });
  });

  test("does not set _openrouter for non-openrouter providers", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      {
        provider: "openai",
        metadata: { openrouter: { provider: { sort: "throughput" } } },
      },
      params,
    );
    expect(params._openrouter).toBeUndefined();
  });

  test("uses the chat id as OpenRouter's documented sticky-routing session key", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      params,
      "chat-123",
    );
    expect(params.session_id).toBe("lumiverse:chat-123");
  });

  test("does not replace a caller-provided OpenRouter session or cache key", () => {
    const sessionParams: Record<string, unknown> = { session_id: "custom-session" };
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      sessionParams,
      "chat-123",
    );
    expect(sessionParams.session_id).toBe("custom-session");

    const cacheKeyParams: Record<string, unknown> = { prompt_cache_key: "custom-cache-key" };
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      cacheKeyParams,
      "chat-123",
    );
    expect(cacheKeyParams.session_id).toBeUndefined();
  });

  test("no-op for empty metadata", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: undefined },
      params,
    );
    expect(params).toEqual({});
  });
});

describe("prompt breakdown visibility", () => {
  test("omits synthetic chat history entries without changing total tokens", () => {
    const tokenCount = {
      total_tokens: 42,
      breakdown: [
        { name: "System", type: "block", tokens: 10 },
        { name: "Chat History", type: "chat_history", tokens: 30 },
        { name: "Author's Note", type: "authors_note", tokens: 2 },
      ],
      tokenizer_id: "approx",
      tokenizer_name: "Approximate",
    };

    const visible = __test__.omitChatHistoryTokenBreakdown(tokenCount);

    expect(visible?.total_tokens).toBe(42);
    expect(visible?.breakdown.map((entry) => entry.type)).toEqual([
      "block",
      "authors_note",
    ]);
  });

  test("summarizes chat history tokens separately", () => {
    expect(
      __test__.sumChatHistoryBreakdownTokens([
        { type: "block", tokens: 10 },
        { type: "chat_history", tokens: 30 },
        { type: "chat_history", tokens: 5 },
      ]),
    ).toBe(35);
  });
});
