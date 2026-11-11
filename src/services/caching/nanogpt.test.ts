import { describe, expect, test } from "bun:test";

import type { LlmMessage } from "../../llm/types";
import {
  applyNanoGptCaching,
  computeAutoCutAfterMessageIndex,
  isNanoGptClaudeModel,
} from "./nanogpt";

describe("isNanoGptClaudeModel", () => {
  test("matches bare claude- ids", () => {
    expect(isNanoGptClaudeModel("claude-sonnet-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("claude-haiku-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("claude-opus-4-5")).toBe(true);
  });

  test("matches vendor-prefixed claude routes", () => {
    expect(isNanoGptClaudeModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("anthropic/claude-opus-4-5:thinking")).toBe(true);
  });

  test("rejects non-Claude models", () => {
    expect(isNanoGptClaudeModel("zai-org/glm-5")).toBe(false);
    expect(isNanoGptClaudeModel("openai/gpt-4o")).toBe(false);
    expect(isNanoGptClaudeModel("gemini-2.5-pro")).toBe(false);
    expect(isNanoGptClaudeModel("deepseek-v3")).toBe(false);
    expect(isNanoGptClaudeModel(undefined)).toBe(false);
    expect(isNanoGptClaudeModel(null)).toBe(false);
    expect(isNanoGptClaudeModel("")).toBe(false);
  });
});

describe("applyNanoGptCaching", () => {
  test("emits prompt_caching helper for Claude models when enabled", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true } },
      },
      { params: {}, messages: [] },
    );
    // Top-level `caching` / `stickyProvider` must NOT be emitted — they bias
    // NanoGPT's provider routing to cache-capable upstreams and bypass
    // subscription coverage for non-Anthropic models.
    expect(result.params.caching).toBeUndefined();
    expect(result.params.stickyProvider).toBeUndefined();
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "1h", stickyProvider: true });
  });

  test("defaults ttl to 5m and stickyProvider to true", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-haiku-4-5",
        metadata: { nanogpt_caching: { enabled: true } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: true });
  });

  test("honors stickyProvider=false", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "5m", stickyProvider: false } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: false });
  });

  test("skips non-Claude models (relies on implicit caching)", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true } },
      },
      input,
    );
    // Pass-through — same bundle returned.
    expect(result).toBe(input);
    expect(result.params.prompt_caching).toBeUndefined();
  });

  test("does nothing when caching is disabled", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: false },
      },
      input,
    );
    expect(result).toBe(input);
  });

  test("does nothing when model is unknown", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        metadata: { nanogpt_caching: { enabled: true } },
      },
      input,
    );
    expect(result).toBe(input);
  });

  test("forwards cutAfterMessageIndex when set as a non-negative integer", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, cutAfterMessageIndex: 4 },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({
      enabled: true,
      ttl: "5m",
      stickyProvider: true,
      cutAfterMessageIndex: 4,
    });
  });

  test("accepts snake_case cut_after_message_index alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, cut_after_message_index: 7 },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).cutAfterMessageIndex).toBe(7);
  });

  test("rejects invalid cutAfterMessageIndex values", () => {
    for (const bad of [-1, 1.5, "3", null, NaN, true]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "claude-sonnet-4-5",
          metadata: {
            nanogpt_caching: { enabled: true, cutAfterMessageIndex: bad },
          },
        },
        { params: {}, messages: [] },
      );
      expect((result.params.prompt_caching as any).cutAfterMessageIndex).toBeUndefined();
    }
  });

  test("forwards explicitCacheControl only when explicitly true", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, explicitCacheControl: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).explicitCacheControl).toBe(true);
  });

  test("accepts snake_case explicit_cache_control alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, explicit_cache_control: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).explicitCacheControl).toBe(true);
  });

  test("omits explicitCacheControl when false or unset (NanoGPT default is false)", () => {
    for (const value of [false, undefined, "true", 1]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "claude-sonnet-4-5",
          metadata: {
            nanogpt_caching: { enabled: true, explicitCacheControl: value },
          },
        },
        { params: {}, messages: [] },
      );
      expect((result.params.prompt_caching as any).explicitCacheControl).toBeUndefined();
    }
  });

  test("emits top-level caching:true when forceCacheCapableRouting is set on a non-Claude model", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: {
          nanogpt_caching: { enabled: true, forceCacheCapableRouting: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
    // Non-Claude → no prompt_caching helper.
    expect(result.params.prompt_caching).toBeUndefined();
  });

  test("emits caching:true AND prompt_caching helper for Claude with force-routing", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: {
            enabled: true,
            ttl: "1h",
            stickyProvider: true,
            forceCacheCapableRouting: true,
          },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
    expect(result.params.prompt_caching).toEqual({
      enabled: true,
      ttl: "1h",
      stickyProvider: true,
    });
  });

  test("accepts snake_case force_cache_capable_routing alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: {
          nanogpt_caching: { enabled: true, force_cache_capable_routing: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
  });

  test("does not emit caching:true when forceCacheCapableRouting is anything but strict true", () => {
    for (const value of [false, undefined, "true", 1, null]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "zai-org/glm-5",
          metadata: {
            nanogpt_caching: { enabled: true, forceCacheCapableRouting: value },
          },
        },
        { params: {}, messages: [] },
      );
      expect(result.params.caching).toBeUndefined();
    }
  });
});

describe("computeAutoCutAfterMessageIndex", () => {
  // Shape of a real long-chat payload: a leading system run, alternating
  // history, the depth-injected `user` blocks, then post-history system
  // instructions.
  const buildPayload = (historyPairs: number, injected = 9): LlmMessage[] => {
    const messages: LlmMessage[] = [];
    for (let i = 0; i < 6; i++) messages.push({ role: "system", content: `sys ${i}` });
    for (let i = 0; i < historyPairs; i++) {
      messages.push({ role: "user", content: `u ${i}` });
      messages.push({ role: "assistant", content: `a ${i}` });
    }
    for (let i = 0; i < injected; i++) {
      messages.push({ role: "user", content: `<internal_tracker_${i}> roll ${i}` });
    }
    messages.push({ role: "system", content: "post-history instructions" });
    return messages;
  };

  test("cuts before the volatile tail, not at the end of the payload", () => {
    const messages = buildPayload(50);
    const newestAssistant = messages.reduce(
      (acc, m, i) => (m.role === "assistant" ? i : acc),
      -1,
    );
    expect(newestAssistant).toBe(105);
    // One back off the newest assistant turn, then six reserved messages.
    expect(computeAutoCutAfterMessageIndex(messages)).toBe(98);
  });

  test("keeps the injected tail and post-history system block outside the prefix", () => {
    const messages = buildPayload(50);
    const cut = computeAutoCutAfterMessageIndex(messages)!;
    for (const m of messages.slice(cut + 1)) {
      expect(m.role === "user" || m.role === "assistant" || m.role === "system").toBe(true);
    }
    // Nothing from the injected run (which carries re-rolled macros) is
    // inside the cached prefix.
    expect(messages.slice(0, cut + 1).some((m) => String(m.content).includes("<internal_tracker_"))).toBe(false);
  });

  test("advances by one turn when a turn is appended, so the next request reads the previous prefix", () => {
    const before = computeAutoCutAfterMessageIndex(buildPayload(50))!;
    const after = computeAutoCutAfterMessageIndex(buildPayload(51))!;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(before + 2);
  });

  test("honours a custom tail reserve", () => {
    const messages = buildPayload(50);
    expect(computeAutoCutAfterMessageIndex(messages, 0)).toBe(104);
    expect(computeAutoCutAfterMessageIndex(messages, 12)).toBe(92);
  });

  test("declines when there is no assistant turn yet", () => {
    expect(
      computeAutoCutAfterMessageIndex([
        { role: "system", content: "sys" },
        { role: "user", content: "first message" },
      ]),
    ).toBeUndefined();
    expect(computeAutoCutAfterMessageIndex([])).toBeUndefined();
  });

  test("declines on short chats where a pinned prefix is not worth the write premium", () => {
    expect(computeAutoCutAfterMessageIndex(buildPayload(2))).toBeUndefined();
  });
});

describe("applyNanoGptCaching automatic cut", () => {
  const longChat = (): LlmMessage[] => {
    const messages: LlmMessage[] = [];
    for (let i = 0; i < 6; i++) messages.push({ role: "system", content: `sys ${i}` });
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: `u ${i}` });
      messages.push({ role: "assistant", content: `a ${i}` });
    }
    for (let i = 0; i < 9; i++) messages.push({ role: "user", content: `<internal_${i}>` });
    messages.push({ role: "system", content: "post-history" });
    return messages;
  };

  test("derives cutAfterMessageIndex when the user pinned none", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "anthropic/claude-opus-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true } },
      },
      { params: {}, messages: longChat() },
    );
    expect((result.params as any).prompt_caching.cutAfterMessageIndex).toBe(98);
  });

  test("a pinned index always wins over the derived one", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "anthropic/claude-opus-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, ttl: "1h", cutAfterMessageIndex: 12 },
        },
      },
      { params: {}, messages: longChat() },
    );
    expect((result.params as any).prompt_caching.cutAfterMessageIndex).toBe(12);
  });

  test("autoCut: false restores NanoGPT's own breakpoint placement", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "anthropic/claude-opus-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", autoCut: false } },
      },
      { params: {}, messages: longChat() },
    );
    expect((result.params as any).prompt_caching.cutAfterMessageIndex).toBeUndefined();
  });

  test("tailReserveMessages from metadata reaches the derived cut", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "anthropic/claude-opus-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, ttl: "1h", tail_reserve_messages: 12 },
        },
      },
      { params: {}, messages: longChat() },
    );
    expect((result.params as any).prompt_caching.cutAfterMessageIndex).toBe(92);
  });

  test("non-Claude routes still emit nothing", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h" } },
      },
      { params: {}, messages: longChat() },
    );
    expect((result.params as any).prompt_caching).toBeUndefined();
  });
});
