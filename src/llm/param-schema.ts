export type ParamType = "number" | "integer" | "boolean" | "string" | "string[]";

export interface ParameterSchema {
  type: ParamType;
  default?: any;
  min?: number;
  max?: number;
  description: string;
  required?: boolean;
}

export type ParameterSchemaMap = Record<string, ParameterSchema>;

export type ToolContinuationMode = "native" | "legacy" | "unsupported";

export interface ProviderCapabilities {
  parameters: ParameterSchemaMap;
  requiresMaxTokens: boolean;
  supportsSystemRole: boolean;
  supportsStreaming: boolean;
  apiKeyRequired: boolean;
  modelListStyle: "openai" | "anthropic" | "google" | "none";
  /**
   * Whether this adapter can advertise and parse host function calls.
   *
   * This is intentionally separate from continuation mode: a legacy adapter
   * may support the bounded assistant-text/user-result continuation used by
   * Response and feature-active compatibility paths.
   */
  toolCalling: boolean;
  /** True only when the adapter can force some admitted host tool without naming one. */
  requiredToolChoice: boolean;
  /**
   * Whether this adapter has a provider-native tool continuation wire format.
   * This remains explicit even when `toolContinuationMode` is legacy or
   * unsupported so readiness cannot infer capabilities from an adapter base
   * class.
   */
  nativeToolContinuation: boolean;
  /**
   * Provider wire contract for continuing a tool-bearing response.
   *
   * `native` preserves provider call identities and correlated results;
   * `legacy` is retained for feature-inactive Council compatibility only;
   * `unsupported` must reject agent tools before any provider request.
   */
  toolContinuationMode: ToolContinuationMode;
  /**
   * Whether the adapter can issue an explicit tools-disabled finalization
   * request after a tool continuation reaches its budget.
   */
  toolsDisabledFinalization: boolean;
  /**
   * Compatibility projection consumed by the existing Response/Council loop.
   * New readiness checks use `toolsDisabledFinalization`.
   */
  supportsToolFinalization: boolean;
  /**
   * When true, inline tool-call continuations are sent back as native
   * `tool_use` / `tool_result` parts with the model's reasoning preserved,
   * enabling interleaved thinking — the model keeps reasoning *between*
   * tool calls instead of restarting its chain of thought each round.
   *
   * Only enable this for providers whose message serialization round-trips
   * reasoning across tool turns. Today the generation loop carries reasoning
   * via `reasoning_content` (the OpenAI-compatible carrier used by DeepSeek /
   * Moonshot). Providers that preserve reasoning differently — Anthropic
   * `thinking` blocks with signatures, Gemini thought signatures — must wire
   * their own carrier before turning this on, otherwise sending structured
   * `tool_use` without the required reasoning blocks will be rejected.
   */
  interleavedThinking?: boolean;
}

/** Pre-built schemas for standard parameters. Providers pick the ones they support. */
export const COMMON_PARAMS = {
  temperature: {
    type: "number" as const,
    default: 1,
    min: 0,
    max: 2,
    description: "Controls randomness. Lower values are more deterministic.",
  },
  max_tokens: {
    type: "integer" as const,
    default: 4096,
    min: 1,
    max: 1000000,
    description: "Maximum number of tokens to generate.",
  },
  top_p: {
    type: "number" as const,
    default: 1,
    min: 0,
    max: 1,
    description: "Nucleus sampling: only consider tokens with cumulative probability up to this value.",
  },
  top_k: {
    type: "integer" as const,
    default: 0,
    min: 0,
    max: 500,
    description: "Only sample from the top K most likely tokens.",
  },
  frequency_penalty: {
    type: "number" as const,
    default: 0,
    min: -2,
    max: 2,
    description: "Penalise tokens based on their frequency in the text so far.",
  },
  presence_penalty: {
    type: "number" as const,
    default: 0,
    min: -2,
    max: 2,
    description: "Penalise tokens based on whether they appear in the text so far.",
  },
  stop: {
    type: "string[]" as const,
    description: "Sequences where the model will stop generating further tokens.",
  },
  min_p: {
    type: "number" as const,
    default: 0,
    min: 0,
    max: 1,
    description: "Minimum probability threshold for token sampling.",
  },
  repetition_penalty: {
    type: "number" as const,
    default: 1,
    min: 0,
    max: 3,
    description: "Penalise repeated tokens. Values above 1 discourage repetition.",
  },
  prompt_caching: {
    type: "boolean" as const,
    default: false,
    description: "Automatically cache prompts to reduce cost and latency for repetitive prefixes.",
  },
} satisfies ParameterSchemaMap;
