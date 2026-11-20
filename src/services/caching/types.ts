import type {
  GenerationParameters,
  LlmMessage,
  ToolDefinition,
} from "../../llm/types";

/**
 * Context required to decide which caching strategy applies and how.
 * `provider` is the canonical provider name (`anthropic`, `nanogpt`, ...).
 * `model` is the resolved model id that will be sent on the wire — strategies
 * that gate on model family (e.g. NanoGPT's Claude-only explicit helper) read
 * it from here, not from `metadata`. `metadata` is the connection profile's
 * metadata blob.
 */
export interface CachingContext {
  provider: string;
  model?: string | null;
  metadata?: Record<string, any> | null;
}

/**
 * The mutable surface a caching strategy may transform. `params` may receive
 * extra body-level fields (e.g. NanoGPT `prompt_caching` helper, Anthropic
 * top-level `cache_control`). `messages` and `tools` may be re-emitted with
 * inline `cache_control` markers (Anthropic native breakpoints).
 */
export interface CachingInput {
  params: GenerationParameters;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
}

export type CachingOutput = CachingInput;

export interface CachingStrategy {
  apply(ctx: CachingContext, input: CachingInput): CachingOutput;
}
