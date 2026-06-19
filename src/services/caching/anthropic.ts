import type { LlmMessage, ToolDefinition } from "../../llm/types";
import type { CachingContext, CachingInput, CachingOutput } from "./types";

interface AnthropicPromptCachingConfig {
  enabled: boolean;
  automatic: boolean;
  cacheControl?: Record<string, unknown>;
  breakpoints: {
    tools: boolean;
    system: boolean;
    messages: boolean;
  };
}

const DISABLED: AnthropicPromptCachingConfig = {
  enabled: false,
  automatic: false,
  breakpoints: { tools: false, system: false, messages: false },
};

function resolveConfig(
  metadata: Record<string, any> | null | undefined,
): AnthropicPromptCachingConfig {
  const raw = metadata?.prompt_caching;
  if (raw !== true && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    return DISABLED;
  }
  const record = raw === true ? { type: "ephemeral" } : raw;
  const breakpoints =
    record.breakpoints && typeof record.breakpoints === "object" && !Array.isArray(record.breakpoints)
      ? record.breakpoints
      : {};
  return {
    enabled: true,
    automatic: record.automatic !== false,
    cacheControl: {
      type: "ephemeral",
      ...(record.ttl === "1h" ? { ttl: "1h" } : {}),
    },
    breakpoints: {
      tools: breakpoints.tools === true,
      // Default ON when caching is enabled: the leading system block (character
      // card, world info, instructions) is the largest stable prefix and is
      // identical across every turn AND swipe, so caching it is the
      // highest-leverage win. Without an inline breakpoint the Anthropic API
      // ignores the top-level cache_control flag, so a `prompt_caching: true`
      // connection would otherwise get no real caching. Opt out with
      // `breakpoints.system === false`.
      system: breakpoints.system !== false,
      // Incremental conversation caching stays opt-in (marks the volatile tail).
      messages: breakpoints.messages === true,
    },
  };
}

/** Index of the last message in the leading run of system messages, or -1. */
function lastLeadingSystemIndex(messages: LlmMessage[]): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") break;
    idx = i;
  }
  return idx;
}

/** Index of the last non-system message, or -1. */
function lastNonSystemIndex(messages: LlmMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "system") return i;
  }
  return -1;
}

function applyMessageBreakpoints(
  messages: LlmMessage[],
  config: AnthropicPromptCachingConfig,
): LlmMessage[] {
  if (!config.enabled) return messages;
  // A cache checkpoint covers everything up to and including the marked block,
  // so a single marker at the end of the leading system run caches the whole
  // system prefix without spending extra breakpoints (Anthropic allows 4).
  const systemIdx = config.breakpoints.system
    ? lastLeadingSystemIndex(messages)
    : -1;
  const lastConversationIdx = config.breakpoints.messages
    ? lastNonSystemIndex(messages)
    : -1;
  // Nothing to mark — preserve the original array reference (and avoid GC churn
  // on rapid swipe bursts).
  if (systemIdx === -1 && lastConversationIdx === -1) return messages;
  return messages.map((message, index) => {
    if (index !== systemIdx && index !== lastConversationIdx) return message;
    return { ...message, cache_control: config.cacheControl };
  });
}

function applyToolBreakpoints(
  tools: ToolDefinition[] | undefined,
  config: AnthropicPromptCachingConfig,
): ToolDefinition[] | undefined {
  if (!tools || !config.enabled || !config.breakpoints.tools) return tools;
  return tools.map((tool) => ({ ...tool, cache_control: config.cacheControl }));
}

/**
 * Anthropic native prompt caching.
 *
 * Two coordinated outputs:
 *   1. Copy `metadata.prompt_caching` (truthy) onto `params.prompt_caching`
 *      so the Anthropic provider's `buildBody` can normalize it into the
 *      top-level body `cache_control` field.
 *   2. Attach inline `cache_control` markers: at the end of the leading system
 *      block (on by default when caching is enabled), and — when opted in —
 *      on the last conversation message and the last tool definition. The
 *      inline system marker is what actually enables caching on the Anthropic
 *      API; the top-level flag in (1) alone is ignored by the API.
 */
export function applyAnthropicCaching(
  ctx: CachingContext,
  input: CachingInput,
): CachingOutput {
  const cacheSetting = ctx.metadata?.prompt_caching;
  const params =
    cacheSetting === true ||
    (cacheSetting && typeof cacheSetting === "object" && !Array.isArray(cacheSetting))
      ? { ...input.params, prompt_caching: cacheSetting }
      : input.params;

  const config = resolveConfig(ctx.metadata);
  return {
    params,
    messages: applyMessageBreakpoints(input.messages, config),
    tools: applyToolBreakpoints(input.tools, config),
  };
}

export const __test__ = { resolveConfig, applyMessageBreakpoints, applyToolBreakpoints };
