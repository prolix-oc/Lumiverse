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

// Anthropic permits at most four explicit cache breakpoints in one request.
// Keep that policy here (rather than relying on every request producer to
// remember it) because prompt assembly can emit an arbitrary number of system
// blocks and runtime tools.
const MAX_CACHE_BREAKPOINTS = 4;

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
      // Automatic mode creates tiered checkpoints across the leading system
      // run. This preserves an earlier reusable prefix when a later block
      // contains retrieved memory, world info, or another volatile value.
      // With automatic mode off, system caching is an explicit opt-in.
      system:
        breakpoints.system !== false &&
        (record.automatic !== false || breakpoints.system === true),
      // Incremental conversation caching stays opt-in (marks the volatile tail).
      messages: breakpoints.messages === true,
    },
  };
}

/** Indices in the leading run of system messages. */
function leadingSystemIndices(messages: LlmMessage[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") break;
    indices.push(i);
  }
  return indices;
}

/** Index of the last non-system message, or -1. */
function lastNonSystemIndex(messages: LlmMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "system") return i;
  }
  return -1;
}

/**
 * Spread the available checkpoints across a prefix instead of placing just
 * one at its volatile tail. Cache prefixes are cumulative: if a retrieved
 * block changes, Anthropic can still reuse the longest earlier checkpoint
 * whose preceding content is unchanged.
 */
function evenlySpacedIndices(indices: number[], limit: number): number[] {
  if (limit <= 0 || indices.length === 0) return [];
  if (indices.length <= limit) return indices;

  const selected: number[] = [];
  for (let ordinal = 1; ordinal <= limit; ordinal++) {
    const position = Math.ceil((ordinal * indices.length) / limit) - 1;
    const index = indices[position]!;
    if (selected[selected.length - 1] !== index) selected.push(index);
  }
  return selected;
}

function applyMessageBreakpoints(
  messages: LlmMessage[],
  config: AnthropicPromptCachingConfig,
  systemCheckpointLimit: number,
): LlmMessage[] {
  if (!config.enabled) return messages;
  const systemIndices = config.breakpoints.system
    ? config.automatic
      ? evenlySpacedIndices(leadingSystemIndices(messages), systemCheckpointLimit)
      : leadingSystemIndices(messages).slice(-1)
    : [];
  const lastConversationIdx = config.breakpoints.messages
    ? lastNonSystemIndex(messages)
    : -1;
  // Nothing to mark — preserve the original array reference (and avoid GC churn
  // on rapid swipe bursts).
  if (systemIndices.length === 0 && lastConversationIdx === -1) return messages;
  const checkpointIndices = new Set(systemIndices);
  if (lastConversationIdx !== -1) checkpointIndices.add(lastConversationIdx);
  return messages.map((message, index) => {
    if (!checkpointIndices.has(index)) return message;
    return { ...message, cache_control: config.cacheControl };
  });
}

function applyToolBreakpoints(
  tools: ToolDefinition[] | undefined,
  config: AnthropicPromptCachingConfig,
): ToolDefinition[] | undefined {
  if (!tools || !config.enabled || !config.breakpoints.tools) return tools;
  // Tool definitions are themselves a prefix. Marking only the last one
  // caches the complete definition list while consuming one breakpoint rather
  // than one per tool (which can exceed Anthropic's request limit).
  return tools.map((tool, index) =>
    index === tools.length - 1
      ? { ...tool, cache_control: config.cacheControl }
      : tool,
  );
}

/**
 * Anthropic native prompt caching.
 *
 * Two coordinated outputs:
 *   1. Copy `metadata.prompt_caching` (truthy) onto `params.prompt_caching`
 *      so the Anthropic provider's `buildBody` can normalize it into the
 *      top-level body `cache_control` field.
 *   2. Attach inline `cache_control` markers. Automatic mode tiers them across
 *      the leading system prefix, so a changing retrieved block cannot evict
 *      every earlier static block. When opted in, the planner also reserves a
 *      marker for the conversation tail and the final tool definition. The
 *      request never exceeds Anthropic's four-breakpoint limit.
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
  // Reserve a checkpoint for each independently cacheable request section
  // before assigning the remainder to the leading system prefix.
  const reservedBreakpoints =
    (config.breakpoints.tools && input.tools?.length ? 1 : 0) +
    (config.breakpoints.messages && lastNonSystemIndex(input.messages) !== -1 ? 1 : 0);
  const systemCheckpointLimit = Math.max(
    0,
    MAX_CACHE_BREAKPOINTS - reservedBreakpoints,
  );
  return {
    params,
    messages: applyMessageBreakpoints(
      input.messages,
      config,
      systemCheckpointLimit,
    ),
    tools: applyToolBreakpoints(input.tools, config),
  };
}

export const __test__ = {
  resolveConfig,
  leadingSystemIndices,
  evenlySpacedIndices,
  applyMessageBreakpoints,
  applyToolBreakpoints,
};
