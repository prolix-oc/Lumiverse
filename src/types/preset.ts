import type { AgentConfigReviewV1, AgentConfigV2 } from "./agents";

export type PresetMetadata = Record<string, any>;

export interface Preset {
  id: string;
  name: string;
  provider: string;
  engine: string;
  parameters: Record<string, any>;
  prompt_order: any[];
  prompts: Record<string, any>;
  metadata: PresetMetadata;
  /** Normalized V2 projection; Agentic runtime metadata aliases are always stripped. */
  agent_config?: AgentConfigV2;
  agent_config_revision?: number;
  agent_config_review?: AgentConfigReviewV1;
  cache_revision?: number;
  created_at: number;
  updated_at: number;
}

export interface CreatePresetInput {
  name: string;
  provider: string;
  engine?: string;
  parameters?: Record<string, any>;
  prompt_order?: any[];
  prompts?: Record<string, any>;
  metadata?: PresetMetadata;
  /** Import-only preset-bound regex companions; never persisted in the preset row. */
  regex_scripts?: readonly Record<string, unknown>[];
  /** Normalized V2 config is written through the authenticated config authority. */
  agent_config?: AgentConfigV2;
}

export type UpdatePresetInput = Partial<CreatePresetInput> & {
  /** Transport-only optimistic concurrency precondition; never persisted. */
  expected_cache_revision?: number;
  /** Required when an ordinary update submits agent_config. */
  expected_config_revision?: number;
};

export class PresetRevisionConflictError extends Error {
  readonly code = "PRESET_REVISION_CONFLICT";
  readonly presetId: string;
  readonly expectedCacheRevision: number;
  readonly actualCacheRevision: number;

  constructor(presetId: string, expectedCacheRevision: number, actualCacheRevision: number) {
    super(
      `Preset ${presetId} changed since revision ${expectedCacheRevision}; current revision is ${actualCacheRevision}`,
    );
    this.name = "PresetRevisionConflictError";
    this.presetId = presetId;
    this.expectedCacheRevision = expectedCacheRevision;
    this.actualCacheRevision = actualCacheRevision;
  }
}

// --- Loom Preset Assembly Types ---
/** Prompt markers whose content and admission are resolved by native assembly. */
export const STRUCTURAL_PROMPT_MARKERS = new Set([
  "chat_history",
  "world_info_before",
  "world_info_after",
  "char_description",
  "char_personality",
  "persona_description",
  "scenario",
  "dialogue_examples",
]);

export interface PromptVariableOption {
  id: string;
  label: string;
  value: string;
}

export type PromptVariableDef =
  | {
      id: string;
      name: string;
      label: string;
      type: 'text';
      defaultValue: string;
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'textarea';
      defaultValue: string;
      rows?: number;
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'number';
      defaultValue: number;
      min?: number;
      max?: number;
      step?: number;
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'slider';
      defaultValue: number;
      min: number;
      max: number;
      step?: number;
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'select';
      /** Stored selection: an option id. */
      defaultValue: string;
      options: PromptVariableOption[];
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'switch';
      /** 0 (off) or 1 (on). */
      defaultValue: 0 | 1;
      description?: string;
    }
  | {
      id: string;
      name: string;
      label: string;
      type: 'multiselect';
      /** Stored selection: array of option ids. */
      defaultValue: string[];
      options: PromptVariableOption[];
      /** String inserted between joined option values. Defaults to two newlines. */
      separator?: string;
      description?: string;
    };

export type PromptVariableType = PromptVariableDef['type'];
export type PromptVariableValue = string | number | string[];
export type PromptVariableValues = Record<string /* blockId */, Record<string /* varName */, PromptVariableValue>>;

/** A complete insertion configuration that can be selected by a prompt variable. */
export interface PromptBlockPlacement {
  role: 'system' | 'user' | 'assistant' | 'user_append' | 'assistant_append';
  position: 'pre_history' | 'post_history' | 'in_history';
  depth: number;
}

/**
 * Lets a select variable declared on this block choose its effective insertion
 * configuration. The variable id is used instead of its name so renaming a
 * variable cannot silently break the binding.
 */
export interface PromptBlockPlacementBinding {
  variableId: string;
  options: Record<string /* select option id */, PromptBlockPlacement>;
}

export interface PromptBlock {
  id: string;
  name: string;
  content: string;
  role: 'system' | 'user' | 'assistant' | 'user_append' | 'assistant_append';
  enabled: boolean;
  position: 'pre_history' | 'post_history' | 'in_history';
  depth: number;
  marker: string | null;
  isLocked: boolean;
  color: string | null;
  injectionTrigger: string[];
  characterTagTrigger?: string[];
  group: string | null;
  categoryMode?: 'radio' | 'checkbox' | null;
  variables?: PromptVariableDef[];
  placementBinding?: PromptBlockPlacementBinding;
  /** Stable identity of a user-owned stash entry shared across presets. */
  stashId?: string;
  sealed?: boolean;
  sealedKey?: string;
  sealedSource?: string;
  sealedOriginPresetId?: string;
  sealedOriginVersion?: string | null;
  sealedSha256?: string;
}

export interface PromptBehavior {
  continueNudge: string;
  emptySendNudge: string;
  impersonationPrompt: string;
  groupNudge: string;
  newChatPrompt: string;
  newGroupChatPrompt: string;
  sendIfEmpty: string;
}

export interface CompletionSettings {
  assistantPrefill: string;
  /** Provider-native prefix for the model's reasoning_content. */
  reasoningPrefill?: string;
  assistantImpersonation: string;
  continuePrefill: boolean;
  continuePostfix: string;
  namesBehavior: number;
  squashSystemMessages: boolean;
  useSystemPrompt: boolean;
  enableWebSearch: boolean;
  sendInlineMedia: boolean;
  enableFunctionCalling: boolean;
  includeUsage: boolean;
}

export interface SamplerOverrides {
  enabled: boolean;
  maxTokens: number | null;
  contextSize: number | null;
  temperature: number | null;
  topP: number | null;
  minP: number | null;
  topK: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  repetitionPenalty: number | null;
  /** When explicitly false, the request uses the non-streaming provider path. Defaults to true. */
  streaming?: boolean;
}

/** Extra JSON fields spread onto the provider request body. */
export interface CustomBody {
  enabled: boolean;
  rawJson: string;
}

export interface AdvancedSettings {
  seed: number;
  customStopStrings: string[];
  collapseMessages: boolean;
  /** Drop a trailing word when a streamed response ends directly on it. */
  trimIncompleteWords?: boolean;
}

export interface AuthorsNote {
  content: string;
  position: number;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}
