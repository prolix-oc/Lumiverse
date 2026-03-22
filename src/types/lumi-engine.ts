// Lumi Engine — Types & Interfaces

export interface LumiModule {
  key: string;
  name: string;
  enabled: boolean;
  prompt: string;
}

/** A named group of pipelines. */
export interface LumiPipeline {
  key: string;
  name: string;
  enabled: boolean;
  modules: LumiModule[];
}

/** Per-preset sidecar LLM configuration. */
export interface LumiSidecarConfig {
  connectionProfileId: string | null;
  model: string | null;
  temperature: number;
  topP: number;
  maxTokensPerModule: number;
  contextWindow: number;
}

// Note for self: wtf am i doing
/** Default sidecar configuration. */
export const LUMI_SIDECAR_DEFAULTS: LumiSidecarConfig = {
  connectionProfileId: null,
  model: null,
  temperature: 0.3,
  topP: 0.9,
  maxTokensPerModule: 512,
  contextWindow: 2048,
};

/** Configuration for a named group of prompt blocks. */
export interface BlockGroupConfig {
  name: string;
  mode: 'radio' | 'checkbox';
  order: number;
  collapsed?: boolean;
}

/** Metadata */
export interface LumiPresetMetadata {
  pipelines: LumiPipeline[];
  sidecar: LumiSidecarConfig;
  blockGroups?: BlockGroupConfig[];
}

/** Result of a single pipeline module  */
export interface LumiModuleResult {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Result of executing all enabled pipelines. */
export type LumiPipelineResult = Map<string, LumiModuleResult>;

//Second note to self: prob change this??
/** Input for pipeline execution. */
export interface LumiPipelineInput {
  userId: string;
  chatId: string;
  pipelines: LumiPipeline[];
  sidecar: LumiSidecarConfig;
  messages: import("../types/message").Message[];
  character: import("../types/character").Character;
  persona: import("../types/persona").Persona | null;
  chat: import("../types/chat").Chat;
  signal?: AbortSignal;
}

/** The .lumi JSON file format for import/export. */
export interface LumiFileFormat {
  version: 2;
  name: string;
  provider: string;
  pipelines: LumiPipeline[];
  sidecar: LumiSidecarConfig;
  blockGroups?: BlockGroupConfig[];
  parameters: Record<string, any>;
  prompts: Record<string, any>;
  prompt_order: any[];
}
