import type {
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
} from './agent-runtime'

export const AGENTIC_GENERATION_TYPES = ['normal', 'continue', 'regenerate', 'swipe'] as const

export type AgenticGenerationType = (typeof AGENTIC_GENERATION_TYPES)[number]
export type AgentRuntimeMode = 'response' | 'agentic'
export type RuntimeRevision = string | number

export const AGENT_RUNTIME_REPAIR_CODES = [
  'agent_config_missing',
  'agent_config_disabled',
  'agent_config_review_required',
  'agent_config_repair_required',
  'agentic_mode_not_allowed',
  'agentic_slot_unresolved',
  'agentic_slot_stale',
  'agentic_capability_missing_generation',
  'agentic_capability_missing_streaming',
  'agentic_capability_missing_tool_calling',
  'agentic_capability_missing_native_tool_continuation',
  'agentic_capability_missing_tools_disabled_finalization',
  'agentic_domain_mismatch',
  'agentic_generation_type_unsupported',
  'agentic_target_unsupported',
  'agentic_input_revisions_incomplete',
  'agentic_readiness_unavailable',
  'agentic_kill_switch',
  'schema_unavailable',
  'reconciliation_required',
  'archive_registry_unavailable',
  'isolate_unavailable',
  'publication_store_unavailable',
  'provider_capability_unavailable',
  'input_revisions_incomplete',
  'kill_switch_off',
  'cognition_invalid',
  'cognition_repair_required',
  'cognition_missing_block_revision',
  'cognition_missing_pack_revision',
  'cognition_deleted_attachment',
  'cognition_predicate_limit_exceeded',
  'cognition_authorization_stale',
  'cognition_import_review_required',
  'cognition_foreign_authority_blocked',
  'agentic_connection_unavailable',
  'agentic_response_escape',
  'decision_capacity_exceeded',
  'decision_refresh_required',
  'loom_policy_invalid',
  'loom_policy_unavailable',
  'loom_policy_stale',
  'loom_policy_authority_widening',
  'loom_policy_repair_required',
] as const

export type AgentRuntimeRepairCode = (typeof AGENT_RUNTIME_REPAIR_CODES)[number]
export type AgentRuntimeRepairCategory = 'slot' | 'provider' | 'isolate' | 'egress' | 'readiness'

export interface GenerationTargetV1 {
  generationType: AgenticGenerationType
  messageId?: string | null
  swipeId?: number | null
  branchId?: string | null
  targetCharacterId?: string | null
  revision?: RuntimeRevision | null
}

export interface EffectiveRuntimeRequestV1 {
  chatId: string
  connectionId?: string | null
  presetId?: string | null
  forcePresetId?: boolean
  personaId?: string | null
  targetCharacterId?: string | null
  generationType?: AgenticGenerationType | string
  target?: GenerationTargetV1 | null
  mode?: AgentRuntimeMode
  requestEpoch?: RuntimeRevision
}

export interface SafeConnectionProjectionV1 {
  id: string | null
  label: string | null
  provider: string | null
  model: string | null
  revision: RuntimeRevision | null
  endpointRevision: RuntimeRevision | null
  credentialRevision: RuntimeRevision | null
  candidateRevision: RuntimeRevision | null
}

export interface SafePresetProjectionV1 {
  id: string | null
  label: string | null
  revision: RuntimeRevision | null
  source: 'chat' | 'persona' | 'character' | 'connection' | 'default' | 'forced' | 'none'
}

export type AgentRuntimeCapabilityRequirement =
  | 'generation'
  | 'streaming'
  | 'tool_calling'
  | 'native_tool_continuation'
  | 'tools_disabled_finalization'

export interface CapabilityReadinessV1 {
  ready: boolean
  sameDomain: boolean
  required: readonly AgentRuntimeCapabilityRequirement[]
  missing: readonly AgentRuntimeCapabilityRequirement[]
  repairCodes: readonly AgentRuntimeRepairCode[]
  responseEscape: 'available'
}
export const LOOM_RUNTIME_POLICY_VERSION = 1 as const
export const LOOM_RUNTIME_POLICY_SOURCES = [
  'authenticated_one_turn',
  'durable_chat_override',
  'reviewed_preset_default',
  'response_fallback',
  'host_cap',
  'host_rejected',
] as const
export const LOOM_RUNTIME_POLICY_SCOPES = ['turn', 'chat', 'preset', 'fallback', 'host'] as const
export const LOOM_RUNTIME_POLICY_AVAILABILITY = [
  'available',
  'unavailable',
  'stale',
  'invalid',
  'denied',
  'omitted',
] as const

export type LoomRuntimePolicySourceV1 = (typeof LOOM_RUNTIME_POLICY_SOURCES)[number]
export type LoomRuntimePolicyScopeV1 = (typeof LOOM_RUNTIME_POLICY_SCOPES)[number]
export type LoomRuntimePolicyAvailabilityStateV1 = (typeof LOOM_RUNTIME_POLICY_AVAILABILITY)[number]

export interface LoomRuntimePolicyCapV1 {
  authority: 'host'
  allowedModes: readonly AgentRuntimeMode[]
  reasonCode: AgentRuntimeRepairCode | null
}

export interface LoomRuntimePolicyAvailabilityV1 {
  state: LoomRuntimePolicyAvailabilityStateV1
  reasonCode: AgentRuntimeRepairCode | null
}

export interface LoomRuntimePolicyTransientSelectionV1 {
  mode: AgentRuntimeMode
  turnFence: RuntimeRevision
  authenticated: true
}

export interface LoomRuntimePolicyDurableChatOverrideV1 {
  mode: AgentRuntimeMode | null
  revision: number
  state: 'ready' | 'review_required' | 'repair_required'
  reviewCode: string | null
  acknowledged: boolean
}

export interface LoomRuntimePolicyRepairAcknowledgementV1 {
  state: 'not_required' | 'required' | 'acknowledged'
  presetRevision: RuntimeRevision | null
  reasonCode: string | null
  acknowledgedAt: number | null
}

export interface LoomRuntimePolicyV1 {
  version: typeof LOOM_RUNTIME_POLICY_VERSION
  authoredValue: AgentRuntimeMode
  effectiveValue: AgentRuntimeMode
  source: LoomRuntimePolicySourceV1
  scope: LoomRuntimePolicyScopeV1
  cap: LoomRuntimePolicyCapV1
  availability: LoomRuntimePolicyAvailabilityV1
  presetRevision: RuntimeRevision | null
  transientSelection: LoomRuntimePolicyTransientSelectionV1 | null
  durableChatOverride: LoomRuntimePolicyDurableChatOverrideV1 | null
  repairAcknowledgement: LoomRuntimePolicyRepairAcknowledgementV1
  nextTurnOnly: true
}

export interface ChatAgentModeOverrideV1 {
  mode: AgentRuntimeMode | null
  revision: number
  state: 'ready' | 'review_required' | 'repair_required'
  reviewCode?: string | null
  acknowledged?: boolean
}

export interface EffectiveRuntimePublicResponseV1 {
  version: 1
  chatId: string
  target: GenerationTargetV1
  connection: SafeConnectionProjectionV1
  preset: SafePresetProjectionV1
  agentsEnabled: boolean
  allowedModes: readonly AgentRuntimeMode[]
  defaultMode: AgentRuntimeMode
  requestedMode: AgentRuntimeMode
  effectiveMode: AgentRuntimeMode
  inspection: LoomPromptInspectionV1
  responseOmission: LoomResponsePolicyOmissionV1 | null
  runtimePolicy: LoomRuntimePolicyV1
  chatOverride: ChatAgentModeOverrideV1 | null
  capabilityReadiness: CapabilityReadinessV1
  repairCodes: readonly AgentRuntimeRepairCode[]
  runtimeDecisionToken: string | null
  runtimeDecisionExpiresAt: number | null
}

export type EffectiveRuntimeDisplayV1 = Omit<
  EffectiveRuntimePublicResponseV1,
  'runtimeDecisionToken' | 'runtimeDecisionExpiresAt'
>

export interface ChatAgentModeWriteV1 {
  mode: AgentRuntimeMode | null
  expectedRevision: number
}

export interface ChatAgentModeWriteResponseV1 {
  chatId: string
  mode: AgentRuntimeMode | null
  revision: number
  state: ChatAgentModeOverrideV1['state']
  appliesTo?: 'next_turn'
}

const PROVIDER_REPAIRS: Partial<Record<AgentRuntimeRepairCode, true>> = {
  agentic_capability_missing_generation: true,
  agentic_capability_missing_streaming: true,
  agentic_capability_missing_tool_calling: true,
  agentic_capability_missing_native_tool_continuation: true,
  agentic_capability_missing_tools_disabled_finalization: true,
  agentic_connection_unavailable: true,
}

export function repairCategoryForCode(code: AgentRuntimeRepairCode): AgentRuntimeRepairCategory {
  if (code === 'agentic_slot_unresolved' || code === 'agentic_slot_stale') return 'slot'
  if (PROVIDER_REPAIRS[code]) return 'provider'
  if (code === 'agentic_domain_mismatch') return 'egress'
  if (code === 'agentic_readiness_unavailable' || code === 'isolate_unavailable') return 'isolate'
  if (code === 'provider_capability_unavailable') return 'provider'
  return 'readiness'
}

export function repairCategoriesForDecision(
  decision: Pick<EffectiveRuntimePublicResponseV1, 'repairCodes' | 'capabilityReadiness'>,
): AgentRuntimeRepairCategory[] {
  const codes = [...decision.repairCodes, ...decision.capabilityReadiness.repairCodes]
  return [...new Set(codes.map(repairCategoryForCode))]
}

export function isAgenticGenerationType(value: unknown): value is AgenticGenerationType {
  return typeof value === 'string' && (AGENTIC_GENERATION_TYPES as readonly string[]).includes(value)
}
