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

export interface ProviderCapabilities {
  parameters: ParameterSchemaMap;
  requiresMaxTokens: boolean;
  supportsSystemRole: boolean;
  supportsStreaming: boolean;
  apiKeyRequired: boolean;
  modelListStyle: "openai" | "anthropic" | "google" | "none";
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
} satisfies ParameterSchemaMap;
