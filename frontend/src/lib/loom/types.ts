import type { LoomPolicyBucketsV1, LoomPolicySourceV1 } from '@/types/agent-runtime'

export const AGENT_INVOCATION_DEFAULT = 64
export const AGENT_INVOCATION_MIN = 1
export const AGENT_TOOL_CALL_DEFAULT = 64
export const AGENT_TOOL_CALL_MIN = 1

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

export interface PromptBlockPlacement {
  role: 'system' | 'user' | 'assistant' | LoomInjectTag
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
}

/** A select variable on this block can choose one of these insertion profiles. */
export interface PromptBlockPlacementBinding {
  variableId: string
  options: Record<string /* select option id */, PromptBlockPlacement>
}

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
  characterTagTrigger?: string[]
  group?: string | null
  categoryMode?: 'radio' | 'checkbox' | null
  /**
   * Child enablement snapshot captured when the category was blanket-
   * disabled via the category-row "and contents" control, restored on the
   * blanket re-enable. Category blocks only.
   */
  savedChildEnabled?: Record<string, boolean>
  variables?: PromptVariableDef[]
  placementBinding?: PromptBlockPlacementBinding
  /** Stable identity of a user-owned stash entry shared across presets. */
  stashId?: string
  /** When uploaded to LumiHub, content is extracted into a private sidecar block. */
  sealed?: boolean
  sealedKey?: string
  /** LumiHub-installed sealed blocks are editable locally but never export raw content. */
  sealedSource?: 'lumihub' | string
  sealedOriginPresetId?: string
  sealedOriginVersion?: string | null
  sealedSha256?: string
  /** Monotonic block revision used by Agentic cognition references. */
  revision?: number
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
  reasoningPrefill?: string
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
  trimIncompleteWords: boolean
}

export type CoreAgentToolId =
  | 'lore_list_books'
  | 'lore_get_book'
  | 'lore_list_entries'
  | 'lore_get_entry'
  | 'lore_search_entries'
  | 'chat_search_history'

export type AgentLoreScope = 'active' | 'all_owned'
export type AgentFailurePolicy = 'required' | 'optional'


export type LoomPassthroughMetadata = Record<string, unknown>

export type AgentMode = 'response' | 'agentic'

export type AgentCapability =
  | 'generation'
  | 'streaming'
  | 'tool_calling'
  | 'native_tool_continuation'
  | 'tools_disabled_finalization'

/** Full workspace operation vocabulary used by the root host frame. */
export const WORKSPACE_OPERATIONS = [
  'read_section',
  'read_page',
  'create_task',
  'update_assigned_progress',
  'submit_child_result',
  'submit_root_result',
  'accept_submission',
  'record_finding',
  'record_decision',
  'record_question',
  'attach_artifact',
  'propose_publication',
] as const
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number]

/** Canonical workspace grants that may be authored for child profiles. */
export const WORKSPACE_CAPABILITIES = [
  'read_section',
  'read_page',
  'update_assigned_progress',
  'submit_child_result',
] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

export type AgentConnectionRef =
  | { kind: 'inherit_main' }
  | { kind: 'slot'; slotId: string }

export interface AgentConnectionSlot {
  id: string
  label: string
  requiredCapabilities: AgentCapability[]
}

export interface AgentPromptBlockRef {
  blockId: string
  expectedPresetRevision: number
  expectedBlockRevision: number
}

export const AGENT_CUSTOM_PHASE_CAPABILITIES = [
  'core_retrieval',
  'workspace_read',
  'workspace_write',
  'delegation',
  'council',
  'cortex',
] as const
export type AgentCustomPhaseCapability = (typeof AGENT_CUSTOM_PHASE_CAPABILITIES)[number]

export interface AgentCustomPhaseV1 {
  version: 1
  id: string
  label: string
  instructionRefs: readonly LoomPolicySourceV1[]
  childInstructionSubsets: readonly {
    profileId: string
    instructionRefs: readonly LoomPolicySourceV1[]
  }[]
  required: boolean
  enter: CognitionPredicate
  exit: CognitionPredicate
  skip?: CognitionPredicate
  capabilityRequests: readonly AgentCustomPhaseCapability[]
  repeatLimit: number
  nextPhaseIds: readonly string[]
}

export interface AgentRuntimePolicyV1 {
  version: 1
  authority: 'loom'
  scope: 'preset'
  defaultMode: AgentMode
  loomPolicy: LoomPolicyBucketsV1 | null
  phases: readonly AgentCustomPhaseV1[]
}

export interface AgentCognitionPolicy {
  workPolicy: AgentPromptBlockRef[]
  workspaceUsage: AgentPromptBlockRef[]
  completionCriteria: AgentPromptBlockRef[]
  renderPolicy: AgentPromptBlockRef[]
}


export type CognitionScalar = string | number | boolean
export type CognitionValue = CognitionScalar | string[]
export type CognitionPhase =
  | 'ASSEMBLE'
  | 'WORK'
  | 'COMPLETE'
  | 'RENDER'
  | 'PREPARE_COMMIT'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'COMMIT_FAILED'
  | 'EXHAUSTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
export type CognitionTaskTransition = 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed'

export type CognitionPredicate =
  | { kind: 'all'; children: CognitionPredicate[] }
  | { kind: 'any'; children: CognitionPredicate[] }
  | { kind: 'not'; child: CognitionPredicate }
  | { kind: 'generation_type'; value: 'normal' | 'continue' | 'regenerate' | 'swipe' }
  | { kind: 'phase'; value: CognitionPhase }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'equals'
      value: CognitionValue
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'in'
      values: CognitionScalar[]
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'includes'
      value: CognitionScalar
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'present'
    }
  | { kind: 'tool_available'; toolId: string; available: boolean }
  | { kind: 'task_transition'; taskId: string; transition: CognitionTaskTransition }

export interface AgentTaskTemplate {
  id: string
  required: boolean
  dependencies?: string[]
  activation?: CognitionPredicate
  label?: string
  description?: string
}

export interface AgentWorkspacePolicy {
  retention: 'turn_terminal' | 'chat_lifetime'
  sharing: 'root_only' | 'view_only'
}

export interface AgentProfileConfigV2 {
  id: string
  name: string
  systemPrompt: string
  connectionRef: AgentConnectionRef
  toolIds: CoreAgentToolId[]
  /** Explicit child-only workspace grants; absent legacy values normalize to none. */
  workspaceCapabilities?: WorkspaceCapability[]
  loreScope: AgentLoreScope
  allowMainDelegation: boolean
  failurePolicy: AgentFailurePolicy
  streamActivity: boolean
  maxOutputTokens: number
  timeoutMs: number
}

export interface AgentConfigV2 {
  version: 2
  agentsEnabled: boolean
  allowedModes: AgentMode[]
  defaultMode: AgentMode
  maxInvocations: number
  maxToolCalls: number
  mainToolIds: CoreAgentToolId[]
  mainLoreScope: AgentLoreScope
  profiles: AgentProfileConfigV2[]
  connectionSlots: AgentConnectionSlot[]
  runtimePolicy?: AgentRuntimePolicyV1
  cognitionPolicy?: AgentCognitionPolicy
  taskPolicy?: {
    templateIds: string[]
  }
  workspacePolicy?: AgentWorkspacePolicy
}

export type AgentConfigReviewState = 'ready' | 'review_required' | 'repair_required'

export type AgentConfigRepairKind =
  | 'unresolved_slot'
  | 'stale_slot'
  | 'disabled_import'
  | 'capability_mismatch'
  | 'stale_block'

export interface AgentConfigRepairItem {
  id: string
  kind: AgentConfigRepairKind
  /** Legacy server projections may include a display label; the editor never renders it. */
  label?: string
  reasonCode: string
  action: {
    kind: 'acknowledge' | 'map_slot' | 'choose_response'
    href?: string
    ref?: string
  }
  /** Legacy compatibility only; acknowledgements are sent as ID lists. */
  acknowledged?: boolean
}

export interface AgentConfigReview {
  state: AgentConfigReviewState
  revision: number
  reasonCode: string | null
  unresolvedSlotIds: string[]
  staleSlotIds: string[]
  /** Legacy compatibility only; acknowledgements are sent as ID lists. */
  acknowledged?: boolean
  items: AgentConfigRepairItem[]
}

export interface AgenticRuntimeHostCeilings {
  childAdmissions: number
  aggregateToolCalls: number
  logicalProviderRequests: number
  physicalDispatchAttempts: number
  childOutputTokens: number
  workAttemptOutputTokens: number
  workAttemptProviderDispatches: number
  workAttemptUnsignedBoundaries: number
  workAttemptToolCalls: number
  workAttemptWorkspaceOperations: number
  workSegmentOutputTokens: number
  workSegmentProviderDispatches: number
  workSegmentUnsignedBoundaries: number
  workSegmentToolCalls: number
  workSegmentWorkspaceOperations: number
  workDispatchOutputTokens: number
  workRecoveryReserveOutputTokens: number
  workFuturePhaseReserveOutputTokens: number
  rootWallClockMs: number
  activityEvents: number
  activityBytes: number
  lifecycleLogRecords: number
  activeRootsPerUser: number
  activeRootsProcess: number
  providerDispatchesPerUser: number
  providerDispatchesProcess: number
  toolExecutionsPerUser: number
  toolExecutionsProcess: number
}

export interface AgenticRuntimeSaveDraft {
  config: AgentConfigV2
  slotBindings: Record<string, string | null>
  taskTemplates: AgentTaskTemplate[]
  reviewAcknowledgements: string[]
  /** Invalid imported rows are quarantined out of the runnable config until discarded. */
  quarantinedProfiles?: AgenticRuntimeQuarantineItem[]
  quarantinedConnectionSlots?: AgenticRuntimeQuarantineItem[]
}

export interface AgenticRuntimeQuarantineItem {
  id: string
  index: number
  reasonCode: 'invalid_profile' | 'invalid_slot'
}

export interface PresetSource {
  type: string
  slug: string | null
  importedVersion: string | null
  importedName: string | null
  importedAt: number
}

/**
 * A portable descriptor for LumiHub-sealed blocks. It carries only the
 * authenticated Hub origin and exact manifest digests; block text is never
 * included in this descriptor.
 */
export interface PortableSealedPresetDescriptorV1 {
  hubPresetId: string
  hubPresetVersion: string
  blocks: Array<{ key: string; sha256: string }>
}

export interface LoomPreset {
  id: string
  name: string
  /** Backend engine identifier; non-classic engines must survive every round trip. */
  engine: string
  description: string
  coverUrl: string | null
  /** Published version label of the source preset (LumiHub install / Loom JSON export). Null for local presets. */
  presetVersion: string | null
  /** Portable provenance label; deliberately separate from LumiHub installation metadata. */
  portableSourceVersion?: string | null
  /** LumiHub provenance metadata (install source, hub id, slug, creator) preserved verbatim across edits. Null when not LumiHub-sourced. */
  lumihubMeta: Record<string, unknown> | null
  /** Metadata not owned by Loom itself, preserved verbatim for extensions and forward compatibility. */
  passthroughMetadata: LoomPassthroughMetadata
  /** Trusted descriptor retained by portable imports for future re-export. */
  portableSealedPreset?: PortableSealedPresetDescriptorV1 | null
  schemaVersion: number
  createdAt: number
  updatedAt: number
  /** Monotonic persisted revision for conditional coordinator updates. Omitted for raw imports. */
  cacheRevision?: number
  agentConfig: AgentConfigV2 | null
  agentConfigRevision: number
  agentConfigReview: AgentConfigReview | null
  agentSlotBindings: Record<string, string | null>
  agentTaskTemplates: AgentTaskTemplate[]
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
  coverUrl: string | null
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
