export interface Preset {
  id: string;
  name: string;
  provider: string;
  engine: string;
  parameters: Record<string, any>;
  prompt_order: any[];
  prompts: Record<string, any>;
  metadata: Record<string, any>;
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
  metadata?: Record<string, any>;
}

export type UpdatePresetInput = Partial<CreatePresetInput>;

// --- Loom Preset Assembly Types ---

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
    };

export type PromptVariableType = PromptVariableDef['type'];
export type PromptVariableValue = string | number;
export type PromptVariableValues = Record<string /* blockId */, Record<string /* varName */, PromptVariableValue>>;

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
  group: string | null;
  categoryMode?: 'radio' | 'checkbox' | null;
  variables?: PromptVariableDef[];
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

export interface AdvancedSettings {
  seed: number;
  customStopStrings: string[];
  collapseMessages: boolean;
}

export interface AuthorsNote {
  content: string;
  position: number;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}
