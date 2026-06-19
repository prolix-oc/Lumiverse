export type LoomInjectTag = 'user_append' | 'assistant_append'

export interface PromptVariableOption {
  id: string
  label: string
  value: string
}

export type PromptVariableDef =
  | {
      id: string
      name: string
      label: string
      type: 'text'
      defaultValue: string
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'textarea'
      defaultValue: string
      rows?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'number'
      defaultValue: number
      min?: number
      max?: number
      step?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'slider'
      defaultValue: number
      min: number
      max: number
      step?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'select'
      defaultValue: string
      options: PromptVariableOption[]
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'switch'
      defaultValue: 0 | 1
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'multiselect'
      defaultValue: string[]
      options: PromptVariableOption[]
      separator?: string
      description?: string
    }

export type PromptVariableType = PromptVariableDef['type']
export type PromptVariableValue = string | number | string[]
export type PromptVariableValues = Record<string /* blockId */, Record<string /* varName */, PromptVariableValue>>

export interface PromptBlock {
  id: string
  name: string
  content: string
  role: 'system' | 'user' | 'assistant' | LoomInjectTag
  enabled: boolean
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
  marker: string | null
  isLocked: boolean
  color: string | null
  injectionTrigger: string[]
  categoryMode?: 'radio' | 'checkbox' | null
  variables?: PromptVariableDef[]
}

export interface SamplerOverrides {
  enabled: boolean
  maxTokens: number | null
  contextSize: number | null
  temperature: number | null
  topP: number | null
  minP: number | null
  topK: number | null
  frequencyPenalty: number | null
  presencePenalty: number | null
  repetitionPenalty: number | null
  streaming: boolean
}

export interface CustomBody {
  enabled: boolean
  rawJson: string
}

export interface PromptBehavior {
  continueNudge: string
  emptySendNudge: string
  impersonationPrompt: string
  groupNudge: string
  newChatPrompt: string
  newGroupChatPrompt: string
  sendIfEmpty: string
}

export interface CompletionSettings {
  assistantPrefill: string
  assistantImpersonation: string
  continuePrefill: boolean
  continuePostfix: string
  namesBehavior: number
  squashSystemMessages: boolean
  useSystemPrompt: boolean
  enableWebSearch: boolean
  sendInlineMedia: boolean
  enableFunctionCalling: boolean
  includeUsage: boolean
}

export interface AdvancedSettings {
  seed: number
  customStopStrings: string[]
  collapseMessages: boolean
}

export interface PresetSource {
  type: string
  slug: string | null
  importedVersion: string | null
  importedName: string | null
  importedAt: number
}

export interface LoomPreset {
  id: string
  name: string
  description: string
  coverUrl: string | null
  /** Published version label of the source preset (LumiHub install / Loom JSON export). Null for local presets. */
  presetVersion: string | null
  /** LumiHub provenance metadata (install source, hub id, slug, creator) preserved verbatim across edits. Null when not LumiHub-sourced. */
  lumihubMeta: Record<string, unknown> | null
  schemaVersion: number
  createdAt: number
  updatedAt: number
  blocks: PromptBlock[]
  source: PresetSource | null
  isDefault: boolean
  samplerOverrides: SamplerOverrides
  customBody: CustomBody
  promptBehavior: PromptBehavior
  completionSettings: CompletionSettings
  advancedSettings: AdvancedSettings
  modelProfiles: Record<string, any>
  lastProfileKey: string | null
  promptVariables: PromptVariableValues
}

export interface LoomRegistryEntry {
  name: string
  blockCount: number
  updatedAt: number
  isDefault: boolean
}

export interface LoomConnectionProfile {
  mainApi: string
  source: string | null
  model: string | null
  supportedParams: Set<string>
}

export interface SamplerParam {
  key: string
  label: string
  apiKey: string
  type: 'int' | 'float'
  min: number
  max: number
  step: number
  defaultHint: number
  unit?: string
  optIn?: boolean
  includeToggle?: boolean
  apiKeyBySource?: Record<string, string>
}

export interface MacroEntry {
  name: string
  syntax: string
  description: string
  args?: { name: string; optional?: boolean }[]
  returns?: string
}

export interface MacroGroup {
  category: string
  macros: MacroEntry[]
}

export type PromptTemplateItem =
  | { section: string; name?: never; content?: never; role?: never; description?: never }
  | { name: string; content: string; role: string; description: string; section?: never }

export type AddableMarkerItem = string | { section: string }

export interface InjectionTriggerType {
  value: string
  label: string
  shortLabel: string
}

export interface ContinuePostfixOption {
  value: string
  label: string
}

export interface NamesBehaviorOption {
  value: number
  label: string
}

export interface CategoryGroup {
  categoryBlock: PromptBlock | null
  children: PromptBlock[]
}
