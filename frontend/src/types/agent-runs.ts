import type { LoomPromptInspectionV1 } from './agent-runtime'

import type { RuntimeRevision } from './effective-runtime'
/** Public WORK lifecycle phases owned by the host. */
export type AgentRunPhaseV2 =
  | 'ADMIT'
  | 'ASSEMBLE'
  | 'WORK'
  | 'PREPARE_COMMIT'
  | 'RENDER'
  | 'COMMIT'
  | 'TERMINAL'

/** Public WORK lifecycle statuses owned by the host. */
export type AgentRunStatusV2 = 'pending' | 'running' | 'waiting' | 'cancelling' | 'terminal'
export type AgentRunOutcomeV2 = 'completed' | 'stopped' | 'failed' | 'exhausted' | 'rejected'
export type AgentRunGenerationTypeV2 = 'normal' | 'continue' | 'regenerate' | 'swipe'
export type AgentRunRecoveryActionV2 = 'retry' | 'repair' | 'reselect' | 'use_response' | 'resync' | 'none'
export type AgentActivityNodeKindV2 = 'root' | 'provider' | 'child' | 'tool'
export type AgentActivityNodeStatusV2 =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'omitted'
export type AgentActivityContinuationModeV2 = 'ordinary' | 'finalization' | 'none'

/** Error codes are opaque, allowlisted by the authenticated host projection. */
export type AgentRunPublicErrorCodeV2 = string

export interface AgentWorkTargetIdentityV1 {
  chatId: string
  generationType: AgentRunGenerationTypeV2
  messageId: string | null
  swipeId: number | null
}

export interface AgentWorkAttemptLineageV1 {
  version: 1
  attemptId: string
  previousAttemptId: string | null
  target: AgentWorkTargetIdentityV1
  createdAt: number
}

export interface AgentRunPublicErrorV2 {
  code: AgentRunPublicErrorCodeV2
  category: 'capacity' | 'budget' | 'context' | 'integrity' | 'timeout' | 'cancelled' | 'provider' | 'validation' | 'internal'
  summaryCode: string
  recoveryEligible: boolean
  recoveryAction: AgentRunRecoveryActionV2
  target: AgentWorkTargetIdentityV1 | null
  workPhase: AgentRunPhaseV2
  workStatus: AgentRunStatusV2
  workOutcome: AgentRunOutcomeV2 | null
  reason: string | null
  omissionCount: number
  inspectionAttemptId: string | null
}

export interface AgentRunErrorResponseV2 {
  version: 2
  error: AgentRunPublicErrorV2
}

export interface AgentRunTargetV2 {
  messageId: string
  swipeId: number
}

export interface AgentRunUsageV2 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
}

export interface AgentActivityNodeV2 {
  version: 2
  id: string
  parentId: string | null
  kind: AgentActivityNodeKindV2
  actor: AgentActivityNodeKindV2
  phase: AgentRunPhaseV2
  status: AgentActivityNodeStatusV2
  startedAt: number
  elapsedMs: number
  profileId?: string
  toolId?: string
  roundIndex?: number
  continuationMode?: AgentActivityContinuationModeV2
  usage?: AgentRunUsageV2
  errorCode?: string
}

export interface AgentOmissionMarkerV2 {
  omittedNodeCount: number
  omittedEventCount: number
  firstOmittedSequence: number | null
  lastOmittedSequence: number | null
}

export interface AgentRunTerminalHandoffV2 {
  version: 2
  committed: boolean
  messageId: string | null
  swipeId: number | null
  messageRevision: number | null
  swipeRevision: number | null
}

export interface AgentRunPublicV2 {
  version: 2
  runId: string
  turnId: string
  generationId: string
  chatId: string
  generationType: AgentRunGenerationTypeV2
  target: AgentRunTargetV2 | null
  workPhase: AgentRunPhaseV2
  workStatus: AgentRunStatusV2
  workOutcome: AgentRunOutcomeV2 | null
  recoveryEligible: boolean
  recoveryAction: AgentRunRecoveryActionV2
  omissionCount: number
  inspectionAttemptId: string
  reason: string | null
  attemptLineage: AgentWorkAttemptLineageV1
  revision: number
  sequence: number
  startedAt: number
  updatedAt: number
  activity: AgentActivityNodeV2[]
  usage: AgentRunUsageV2
  omission: AgentOmissionMarkerV2
  error?: AgentRunPublicErrorV2
  terminalHandoff?: AgentRunTerminalHandoffV2
}

export interface AgentRunChangeEventV2 {
  version: 2
  chatId: string
  sequence: number
  run: AgentRunPublicV2
  omission: AgentOmissionMarkerV2
}

export interface ChatRunCursorV1 {
  version: 1
  token: string
}

export interface AgentRunResyncPageV1 {
  /** Zero-based page offset in the bounded full-resync snapshot. */
  offset: number
  returnedRuns: number
  totalRuns: number
  snapshotSequence: number
  complete: boolean
  omittedRuns: number
  /** Older visible runs outside the bounded newest snapshot. */
  omittedOlderRuns: number
}

export interface AgentRunChangesV2 {
  version: 2
  chatId: string
  cursor: ChatRunCursorV1
  /** Sequence consumed by the signed cursor in `cursor`. */
  cursorSequence: number
  /** Processed sequence; always equal to the signed cursor sequence. */
  lastSequence: number
  /** Highest sequence visible to this read snapshot, not a cursor watermark. */
  tailSequence: number
  /** More events or resync pages remain after this response. */
  hasMore: boolean
  resync: boolean
  resyncPage?: AgentRunResyncPageV1
  runs: AgentRunPublicV2[]
  events: AgentRunChangeEventV2[]
  omission: AgentOmissionMarkerV2
}

export type AgentWorkspaceSectionV2 = 'objective' | 'tasks' | 'records' | 'submissions' | 'artifacts'
export type AgentWorkspaceRetentionV2 = 'operational' | 'turn_terminal' | 'chat_lifetime'
export type AgentWorkspaceVisibilityV2 = 'owner' | 'participants' | 'public'

export interface AgentWorkspaceSectionSummaryV2 {
  section: AgentWorkspaceSectionV2
  count: number
  revision: number
  retention: AgentWorkspaceRetentionV2
  visibility: AgentWorkspaceVisibilityV2
}

export interface AgentWorkspaceIndexPublicV2 {
  version: 2
  turnId: string
  workspaceRevision: number
  sections: AgentWorkspaceSectionSummaryV2[]
  omitted: number
}

interface AgentWorkspaceEntryBaseV2 {
  id: string
  revision: number
  retention: AgentWorkspaceRetentionV2
  visibility: AgentWorkspaceVisibilityV2
}

export interface AgentWorkspaceTaskPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'task'
  title: string
  state: 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed'
  required: boolean
  assigned: boolean
  dependencyCount: number
}

export interface AgentWorkspaceSubmissionPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'submission'
  taskId: string
  profileId: string | null
  state: 'submitted' | 'accepted' | 'rejected'
}

export interface AgentWorkspaceRecordPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'finding' | 'decision' | 'question'
  title: string
  state: 'active' | 'accepted' | 'omitted'
}

export interface AgentWorkspaceArtifactPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'artifact'
  name: string
  mimeType: string
  byteCount: number
  digestPrefix: string
  published: boolean
}

export type AgentWorkspaceEntryPreviewV2 =
  | AgentWorkspaceTaskPreviewV2
  | AgentWorkspaceSubmissionPreviewV2
  | AgentWorkspaceRecordPreviewV2
  | AgentWorkspaceArtifactPreviewV2

export interface AgentWorkspaceSectionPreviewV2 {
  version: 2
  turnId: string
  section: AgentWorkspaceSectionV2
  workspaceRevision: number
  entries: AgentWorkspaceEntryPreviewV2[]
  nextPage: string | null
  omitted: number
}

export interface AgentRunStopResultV2 {
  version: 2
  status: 'accepted' | 'too_late' | 'terminal'
  turnId: string
  revision: number
  target: AgentWorkTargetIdentityV1
  workPhase: AgentRunPhaseV2
  workStatus: AgentRunStatusV2
  workOutcome: AgentRunOutcomeV2 | null
  reason: string | null
  recoveryEligible: boolean
  recoveryAction: AgentRunRecoveryActionV2
  omissionCount: number
  inspectionAttemptId: string
  error?: AgentRunPublicErrorV2
}

export type AgentRunSyncStatus = 'idle' | 'stale' | 'restoring' | 'ready' | 'error'

export interface AgentWorkspaceSectionStateV2 {
  preview: AgentWorkspaceSectionPreviewV2
  loadingMore: boolean
  /** A failed section request keeps an explicit retryable state instead of an endless spinner. */
  error?: boolean
}

export interface AgentWorkspaceViewStateV2 {
  chatId: string
  turnId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  index: AgentWorkspaceIndexPublicV2 | null
  sections: Partial<Record<AgentWorkspaceSectionV2, AgentWorkspaceSectionStateV2>>
  error: boolean
}
export type AgentInspectionLifecycleV1 =
  | 'ADMIT'
  | 'ASSEMBLE'
  | 'WORK'
  | 'PREPARE_COMMIT'
  | 'RENDER'
  | 'COMMIT'
  | 'TERMINAL'

export type AgentInspectionStatusV1 = 'pending' | 'running' | 'waiting' | 'cancelling' | 'terminal'
export type AgentInspectionOutcomeV1 = 'completed' | 'stopped' | 'failed' | 'exhausted' | 'rejected'
export type AgentInspectionReasonV1 =
  | 'none'
  | 'user_stop'
  | 'deadline'
  | 'provider_failure'
  | 'tool_failure'
  | 'required_work_failure'
  | 'budget_exhausted'
  | 'invalid_input'
  | 'stale_input'
  | 'unavailable'
  | 'needs_attention'
  | 'interrupted'
  | 'retry_requested'
  | 'reconciled'
  | 'unknown'
export type AgentInspectionSectionIdV1 =
  | 'run'
  | 'activity'
  | 'transcript'
  | 'turn_session'
  | 'usage'
  | 'prompt'
  | 'cortex'
  | 'council'
  | 'workspace'
export type AgentInspectionSectionStateV1 = 'available' | 'not_recorded' | 'source_deleted' | 'unavailable' | 'withheld'
export interface AgentInspectionSectionAvailabilityV1 {
  section: AgentInspectionSectionIdV1
  state: AgentInspectionSectionStateV1
  reason: AgentInspectionReasonV1 | null
}
export type AgentInspectionTargetKindV1 = AgentRunGenerationTypeV2

export interface AgentInspectionCorrelationV1 {
  turnSessionId: string
  runId: string
  attemptId: string
  chatId: string
  generationId: string
  messageId: string | null
  swipeId: number | null
  actorId: string | null
  recipientId: string | null
  phase: AgentInspectionLifecycleV1
  taskId: string | null
  toolId: string | null
  parentId: string | null
  hostCorrelationId: string
  hostSequence: number
}

export type AgentInspectionAttemptLineageV1 = AgentWorkAttemptLineageV1
export type AgentInspectionRecordKindV1 =
  | 'prompt'
  | 'provider_exchange'
  | 'agent_exchange'
  | 'delegation'
  | 'child_result'
  | 'tool'
  | 'condition'
  | 'checkpoint'
  | 'task'
  | 'workspace'
  | 'hook'
  | 'usage'
  | 'failure'
  | 'terminal'
  | 'stop'
  | 'recovery'
  | 'milestone'
export type AgentInspectionRecordActorV1 = 'host' | 'owner' | 'provider' | 'agent' | 'child' | 'tool' | 'cortex' | 'council'

export interface AgentInspectionProviderIdentityV1 {
  adapter: string
  providerId: string | null
  modelId: string | null
  connectionId?: string | null
  configRevision?: RuntimeRevision | null
  connectionRevision: RuntimeRevision | null
  fingerprint: string | null
}

export interface AgentInspectionTranscriptRecordV1 {
  version: 1
  id: string
  kind: AgentInspectionRecordKindV1
  actor: AgentInspectionRecordActorV1
  recipient: AgentInspectionRecordActorV1 | null
  correlation: AgentInspectionCorrelationV1
  occurredAt: number
  durationMs: number | null
  late: boolean
  content: string | null
  arguments: string | null
  result: string | null
  provider: AgentInspectionProviderIdentityV1 | null
  errorReason: AgentInspectionReasonV1 | null
}

export type AgentTurnSessionEntryKindV1 =
  | 'target'
  | 'input'
  | 'policy'
  | 'condition'
  | 'hook'
  | 'cancellation'
  | 'completion'
  | 'commit'
  | 'terminal'
  | 'retry'
  | 'recovery'

export interface AgentTurnSessionEntryV1 {
  version: 1
  id: string
  kind: AgentTurnSessionEntryKindV1
  correlation: AgentInspectionCorrelationV1
  occurredAt: number
  detail: string
  transcriptRecordIds: string[]
}

export type AgentInspectionMarkerKindV1 =
  | 'reconnect_gap'
  | 'late_event'
  | 'reordered_event'
  | 'truncated'
  | 'unavailable'
  | 'credentials_withheld'
  | 'other_user_data_withheld'
  | 'recovered_duplicate'
export type AgentInspectionMarkerScopeV1 = 'run' | 'activity' | 'transcript' | 'turn_session' | 'usage' | 'prompt' | 'cortex' | 'council' | 'workspace'

export interface AgentInspectionMarkerV1 {
  version: 1
  id: string
  kind: AgentInspectionMarkerKindV1
  scope: AgentInspectionMarkerScopeV1
  correlation: AgentInspectionCorrelationV1 | null
  firstSequence: number | null
  lastSequence: number | null
  recoverable: boolean | null
  detail: string | null
}

export type AgentInspectionUsageSourceV1 = 'provider_reported' | 'provisional' | 'final' | 'recovered_duplicate'
export type AgentInspectionUsageLayerIdV1 = 'root' | 'child' | 'provider' | 'tool' | 'cortex' | 'council'

export interface AgentInspectionUsageV1 {
  version: 1
  id: string
  source: AgentInspectionUsageSourceV1
  layer?: AgentInspectionUsageLayerIdV1
  correlation: AgentInspectionCorrelationV1 | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
  canonical: boolean
}

export interface AgentInspectionUsageProjectionV1 {
  version: 1
  inspectionAttemptId: string
  totals: AgentRunUsageV2
  layers: AgentInspectionUsageLayerV1[]
  evidenceCount: number
  omittedEvidenceCount: number
}

export interface AgentInspectionUsageLayerV1 {
  version: 1
  layer: AgentInspectionUsageLayerIdV1
  source: AgentInspectionUsageSourceV1
  correlation: AgentInspectionCorrelationV1 | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
  evidenceIds: string[]
  canonical: boolean
}

export type AgentPromptEvidenceDestinationV1 = 'root_work' | 'child_work' | 'completion_handoff' | 'render' | 'council' | 'cortex'
export type AgentPromptEvidenceRoleV1 = 'system' | 'user' | 'assistant' | 'tool' | 'context' | 'policy'

export type AgentPromptRevisionV1 = string | number
export interface AgentPromptDatabankSourceV1 {
  kind: 'automatic' | 'mention'
  databankId: string
  documentId: string
  documentName: string
  chunkId: string | null
  documentContentHash: string | null
  contentHash: string
}
export type AgentPromptNativeProvenanceV1 =
  | { kind: 'world_info'; sourceId: string; sourceRevision: AgentPromptRevisionV1; sourceIndex: number }
  | { kind: 'databank'; sourceRevision: string; sources: AgentPromptDatabankSourceV1[] }
export type AgentRenderCrossingKindV1 = 'accepted_finding' | 'accepted_submission' | 'completion_guidance'
export interface AgentRenderCrossingV1 {
  version: 1
  id: string
  kind: AgentRenderCrossingKindV1
  sourceId: string
  sourceRevision: number | null
  contentDigest: string
  content: string | null
  correlation: AgentInspectionCorrelationV1
}
export interface AgentPromptEvidenceV1 {
  version: 1
  id: string
  sourceId: string
  sourceRevision: AgentPromptRevisionV1
  promptOrder: number
  destination: AgentPromptEvidenceDestinationV1
  role: AgentPromptEvidenceRoleV1
  correlation: AgentInspectionCorrelationV1
  included: boolean
  content: string
  contentDigest: string
  omissionReason: string | null
  nativeProvenance: AgentPromptNativeProvenanceV1 | null
  loomInspection: LoomPromptInspectionV1 | null
}

export type AgentCortexReceiptStateV1 = 'accepted' | 'omitted' | 'failed' | 'cancelled'
export type AgentCortexCheckpointV1 = 'WORK'
export type AgentCortexRevisionV1 = string | number
export type AgentCortexOmissionReasonV1 = 'stale' | 'unauthorized' | 'unavailable' | 'cancelled' | 'failed' | 'limit_exceeded' | 'snapshot_mismatch'
export interface AgentCortexScopeV1 {
  chatId: string
  targetMessageId: string | null
  targetSwipeId: number | null
}

export interface AgentCortexOmissionV1 {
  reason: AgentCortexOmissionReasonV1
  required: boolean
  detail: string | null
}
export interface AgentCortexReceiptV1 {
  version: 1
  id: string
  requestId: string
  attemptId: string
  checkpoint: AgentCortexCheckpointV1
  snapshotId: string
  sourceRevision: AgentCortexRevisionV1
  revision: AgentCortexRevisionV1
  scope: AgentCortexScopeV1
  required: boolean
  startedAt: number
  completedAt: number | null
  state: AgentCortexReceiptStateV1
  resultDigest: string | null
  resultCount: number
  correlation: AgentInspectionCorrelationV1
  reason: AgentInspectionReasonV1 | null
  omission: AgentCortexOmissionV1 | null
  canonical: false
}

export interface AgentCouncilReceiptV1 {
  version: 1
  id: string
  requestId: string
  checkpoint: AgentCortexCheckpointV1
  required: boolean
  startedAt: number
  completedAt: number | null
  state: AgentCortexReceiptStateV1
  memberCount: number
  resultDigest: string | null
  correlation: AgentInspectionCorrelationV1
  reason: AgentInspectionReasonV1 | null
  canonical: false
}

export type AgentWorkspaceAssociationObjectKindV1 =
  | 'objective'
  | 'task'
  | 'finding'
  | 'decision'
  | 'question'
  | 'submission'
  | 'artifact'
  | 'publication'

export interface AgentWorkspaceAssociationV1 {
  version: 1
  id: string
  workspaceId: string
  workspaceRevision: number
  relation: 'linked' | 'published' | 'omitted'
  objectKind: AgentWorkspaceAssociationObjectKindV1
  objectId: string | null
  sourceRevision: number | null
  sourceDeleted: boolean
  provenanceDigest: string | null
  correlation: AgentInspectionCorrelationV1
}

export interface AgentActivityMilestoneV1 {
  version: 1
  id: string
  parentId: string | null
  kind: 'root' | 'provider' | 'child' | 'tool' | 'milestone'
  actor: AgentInspectionRecordActorV1
  phase: AgentInspectionLifecycleV1
  status: AgentInspectionStatusV1 | 'omitted'
  label: string
  toolId: string | null
  taskId: string | null
  sequence: number
  startedAt: number
  endedAt: number | null
  elapsedMs: number | null
  usage: AgentInspectionUsageV1 | null
  correlation: AgentInspectionCorrelationV1
}

export interface AgentActivityTreeV1 {
  version: 1
  attempt: AgentInspectionAttemptLineageV1
  lifecycle: AgentInspectionLifecycleV1
  status: AgentInspectionStatusV1
  outcome: AgentInspectionOutcomeV1 | null
  reason: AgentInspectionReasonV1
  revision: number
  startedAt: number
  updatedAt: number
  terminalAt: number | null
  target: AgentRunTargetV2 | null
  milestones: AgentActivityMilestoneV1[]
  usage: AgentRunUsageV2
  markers: AgentInspectionMarkerV1[]
  reconciliation: 'authoritative' | 'reconciling' | 'recovered' | 'stale'
}

export interface AgentRunInspectionSummaryV1 {
  version: 1
  attempt: AgentInspectionAttemptLineageV1
  runId: string
  turnSessionId: string
  generationId: string
  hostCorrelationId: string
  lifecycle: AgentInspectionLifecycleV1
  status: AgentInspectionStatusV1
  outcome: AgentInspectionOutcomeV1 | null
  reason: AgentInspectionReasonV1
  target: AgentRunTargetV2 | null
  committedTarget: AgentRunTargetV2 | null
  revision: number
  startedAt: number
  updatedAt: number
  terminalAt: number | null
  activity: AgentActivityTreeV1
  markerCount: number
  transcriptCount: number
  terminal: boolean
}

export type AgentInspectionAuthorityV1 = 'host' | 'preset' | 'provider' | 'owner' | 'system' | 'cortex' | 'council'
export type AgentInspectionSourceV1 = 'execution' | 'projection' | 'provider' | 'tool' | 'host' | 'recovery' | 'cortex' | 'council' | 'unknown'
export type AgentInspectionScopeV1 = 'run' | 'attempt' | 'turn_session' | 'target' | 'phase' | 'provider' | 'tool' | 'usage' | 'transcript' | 'cortex' | 'council' | 'workspace'

export interface AgentInspectionCapGateV1 {
  id: string
  limit: number | null
  observed: number | null
  exceeded: boolean
  authority: AgentInspectionAuthorityV1
  source: AgentInspectionSourceV1
}

export interface AgentInspectionErrorDetailV1 {
  version: 1
  inspectionAttemptId: string
  code: string
  category: AgentRunPublicErrorV2['category']
  summaryCode: string
  causalCode: string | null
  authority: AgentInspectionAuthorityV1
  source: AgentInspectionSourceV1
  scope: AgentInspectionScopeV1
  capGate: AgentInspectionCapGateV1 | null
  target: AgentWorkTargetIdentityV1
  workPhase: AgentRunPhaseV2
  workStatus: AgentRunStatusV2
  workOutcome: AgentRunOutcomeV2 | null
  reason: string | null
  recoveryEligible: boolean
  recoveryAction: AgentRunRecoveryActionV2
  omissionCount: number
}

export interface AgentRunInspectionStopV1 {
  version: 1
  state: 'accepted' | 'too_late' | 'terminal' | 'failed' | 'reconciled'
  requestedAt: number
  receiptAt: number | null
  correlation: AgentInspectionCorrelationV1
  reason: AgentInspectionReasonV1
}
export interface AgentRunInspectionRetryV1 {
  allowed: boolean
  reason: AgentInspectionReasonV1
  targetValid: boolean
  linkedAttemptId: string | null
}
export type WorkSegmentBoundaryClassV1 = 'tool_action' | 'tool_free_stop' | 'reasoning_only_stop' | 'reasoning_only_length' | 'empty_provider_response' | 'provider_protocol_failure'
export interface WorkSegmentUsageInspectionV1 {
  providerDispatches: number
  providerInputTokens: number
  providerOutputTokens: number
  providerTotalTokens: number
  billedOutputTokens: number
  toolCalls: number
  workspaceOperations: number
  unsignedBoundaries: number
  receiveBytes: number
  publishedOutputBytes: number
}
export interface WorkSegmentIdentityInspectionV1 {
  segmentId: string
  phaseId: string | null
  phaseIndex: number
  phaseOccurrence: number
  segmentOrdinal: number
}
export interface WorkSegmentInspectionProjectionV1 {
  recovery: {
    state: 'active' | 'closed'
    phaseId: string | null
    phaseIndex: number | null
    phaseOccurrence: number | null
    nextSegmentOrdinal: number
    currentSegmentId: string | null
    workspaceRevision: number
    terminalCloseResult: 'failed' | 'exhausted' | 'cancelled' | null
    terminalBoundaryClass: WorkSegmentBoundaryClassV1 | null
    usage: WorkSegmentUsageInspectionV1 & { segments: number }
  }
  segments: Array<{
    identity: WorkSegmentIdentityInspectionV1
    lifecycle: 'admitted' | 'running' | 'closed' | 'interrupted' | 'failed' | 'exhausted' | 'cancelled'
    workspaceRevision: number
    boundaryClass: WorkSegmentBoundaryClassV1 | null
    closeResult: 'phase_advanced' | 'phase_repeated' | 'same_phase_rollover' | 'work_complete' | 'failed' | 'exhausted' | 'cancelled' | null
    closedWorkspaceRevision: number | null
    usage: WorkSegmentUsageInspectionV1
  }>
  dispatches: Array<{
    dispatchId: string
    segmentId: string
    dispatchOrdinal: number
    lifecycle: 'reserved' | 'in_flight' | 'settled' | 'interrupted'
    toolMode: 'ordinary' | 'required'
    budgetClass: 'normal' | 'recovery'
    workspaceRevision: number
    settledWorkspaceRevision: number | null
    boundaryClass: WorkSegmentBoundaryClassV1 | null
    usage: WorkSegmentUsageInspectionV1 | null
  }>
  transitions: Array<{
    transitionId: string
    handoffId: string
    transitionKind: 'advance' | 'repeat' | 'rollover' | 'terminal'
    sourceSegment: WorkSegmentIdentityInspectionV1
    sourceWorkspaceRevision: number
    targetPhaseId: string | null
    targetPhaseIndex: number | null
    targetPhaseOccurrence: number | null
    targetSegmentOrdinal: number | null
    cause: WorkSegmentBoundaryClassV1 | null
  }>
}
export interface AgentRunInspectionDetailV1 extends AgentRunInspectionSummaryV1 {
  transcript: AgentInspectionTranscriptRecordV1[]
  turnSession: AgentTurnSessionEntryV1[]
  markers: AgentInspectionMarkerV1[]
  usageEvidence: AgentInspectionUsageV1[]
  usage: AgentInspectionUsageProjectionV1
  error: AgentInspectionErrorDetailV1 | null
  promptEvidence: AgentPromptEvidenceV1[]
  renderCrossings: AgentRenderCrossingV1[]
  cortexReceipts: AgentCortexReceiptV1[]
  councilReceipts: AgentCouncilReceiptV1[]
  workspaceAssociations: AgentWorkspaceAssociationV1[]
  stop: AgentRunInspectionStopV1 | null
  retry: AgentRunInspectionRetryV1
  workSegments: WorkSegmentInspectionProjectionV1 | null
  sectionAvailability: AgentInspectionSectionAvailabilityV1[]
}

export interface AgentRunInspectionListV1 {
  version: 1
  chatId: string
  runs: AgentRunInspectionSummaryV1[]
  nextCursor: string | null
  omission: AgentInspectionMarkerV1 | null
}

export interface AgentRunInspectionRetryResponseV1 {
  version: 1
  accepted: boolean
  attempt: AgentInspectionAttemptLineageV1 | null
  reason: AgentInspectionReasonV1
  target?: AgentWorkTargetIdentityV1
  recoveryEligible?: boolean
  recoveryAction?: AgentRunRecoveryActionV2
  inspectionAttemptId?: string | null
  error?: AgentRunPublicErrorV2
}

export type AgentInspectionAvailabilityStateV1 =
  | 'live'
  | 'recovered'
  | 'terminal'
  | 'stale'
  | 'missing'
  | 'deleted'
  | 'unavailable'

export interface AgentRunInspectionStateV1 {
  status: 'idle' | 'loading' | 'ready' | 'error'
  availability: AgentInspectionAvailabilityStateV1
  detail: AgentRunInspectionDetailV1 | null
  error: AgentRunPublicErrorV2 | null
}
export type AgentPersistentWorkspaceStateValueV1 = 'active' | 'archived'
export type AgentPersistentWorkspaceProgressStateV1 = 'not_started' | 'in_progress' | 'blocked' | 'completed'
export type AgentPersistentWorkspaceTurnPhaseV1 = AgentRunPhaseV2
export type AgentPersistentWorkspaceTurnStatusV1 = AgentRunStatusV2
export type AgentPersistentWorkspaceTerminalOutcomeV1 = AgentRunOutcomeV2
export type AgentPersistentWorkspaceRecordKindV1 = 'finding' | 'decision' | 'question'
export type AgentPersistentWorkspaceSubmissionStateV1 = 'submitted' | 'accepted' | 'rejected'
export type AgentPersistentWorkspacePublicationCategoryV1 = 'task' | 'finding' | 'objective' | 'artifact'

export interface AgentPersistentWorkspaceMetadataV1 {
  title: string
  summary: string
  labels: string[]
  ownerNote: string
}

export interface AgentPersistentWorkspaceProgressV1 {
  state: AgentPersistentWorkspaceProgressStateV1
  percent: number
  summary: string
  updatedAt: number
}

export interface AgentPersistentWorkspaceQuotaV1 {
  maxTasks: number
  maxRecords: number
  maxSubmissions: number
  maxArtifacts: number
  maxPublications: number
  maxBytes: number
}

export interface AgentPersistentWorkspaceUsageV1 {
  taskCount: number
  recordCount: number
  submissionCount: number
  artifactCount: number
  publicationCount: number
  byteCount: number
}

export interface AgentPersistentWorkspaceV1 {
  version: 1
  id: string
  userId: string
  chatId: string | null
  objective: string
  metadata: AgentPersistentWorkspaceMetadataV1
  progress: AgentPersistentWorkspaceProgressV1
  state: AgentPersistentWorkspaceStateValueV1
  revision: number
  quota: AgentPersistentWorkspaceQuotaV1
  usage: AgentPersistentWorkspaceUsageV1
  createdAt: number
  updatedAt: number
}

export interface AgentPersistentWorkspaceTurnSessionV1 {
  version: 1
  id: string
  workspaceId: string
  userId: string
  chatId: string | null
  turnId: string
  attemptId: string
  executionId: string | null
  phase: AgentPersistentWorkspaceTurnPhaseV1
  status: AgentPersistentWorkspaceTurnStatusV1
  outcome: AgentPersistentWorkspaceTerminalOutcomeV1 | null
  revision: number
  createdAt: number
  updatedAt: number
  terminalAt: number | null
}
export interface AgentPersistentWorkspaceTurnSessionPageV1 {
  data: AgentPersistentWorkspaceTurnSessionV1[]
  total: number
  limit: number
  offset: number
}

export type AgentPersistentWorkspaceTaskCreatorV1 = 'host' | 'owner'
export type AgentWorkspaceTaskStateV1 = 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed'

export interface AgentPersistentWorkspaceTaskV1 {
  version: 1
  id: string
  workspaceId: string
  turnSessionId: string | null
  userId: string
  chatId: string | null
  title: string
  objective: string
  state: AgentWorkspaceTaskStateV1
  required: boolean
  dependencyIds: string[]
  creator: AgentPersistentWorkspaceTaskCreatorV1
  hostAdmitted: boolean
  progress: AgentPersistentWorkspaceProgressV1
  summary: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface AgentPersistentWorkspaceRecordContentV1 {
  summary: string
  evidenceIds: string[]
  provenance: string | null
}

export interface AgentPersistentWorkspaceRecordV1 {
  version: 1
  id: string
  workspaceId: string
  turnSessionId: string | null
  userId: string
  chatId: string | null
  kind: AgentPersistentWorkspaceRecordKindV1
  content: AgentPersistentWorkspaceRecordContentV1
  taskId: string | null
  revision: number
  createdAt: number
  updatedAt: number
}

export interface AgentPersistentWorkspaceSubmissionV1 {
  version: 1
  id: string
  workspaceId: string
  turnSessionId: string | null
  taskId: string
  userId: string
  chatId: string | null
  state: AgentPersistentWorkspaceSubmissionStateV1
  summary: string
  resultDigest: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface AgentPersistentWorkspaceArtifactV1 {
  version: 1
  id: string
  workspaceId: string
  turnSessionId: string | null
  userId: string
  chatId: string | null
  blobDigest: string
  mimeType: string
  byteCount: number
  provenance: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface AgentPersistentWorkspacePublicationProvenanceV1 {
  workspaceId: string
  turnSessionId: string | null
  attemptId: string | null
  executionId: string | null
  sourceDigest: string
  sourceChatId: string | null
  sourceMessageId: string | null
  sourceSwipeId: number | null
  sourceDeletedAt: number | null
  creator: string
  capturedAt: number
}

export interface AgentPersistentWorkspaceTaskPublicationCopyV1 {
  category: 'task'
  id: string
  title: string
  objective: string
  state: AgentWorkspaceTaskStateV1
  required: boolean
  dependencyIds: string[]
  progress: AgentPersistentWorkspaceProgressV1
  summary: string
}

export interface AgentPersistentWorkspaceFindingPublicationCopyV1 {
  category: 'finding'
  id: string
  content: AgentPersistentWorkspaceRecordContentV1
  taskId: string | null
}

export interface AgentPersistentWorkspaceObjectivePublicationCopyV1 {
  category: 'objective'
  id: string
  objective: string
  metadata: AgentPersistentWorkspaceMetadataV1
}

export interface AgentPersistentWorkspaceArtifactPublicationCopyV1 {
  category: 'artifact'
  id: string
  blobDigest: string
  mimeType: string
  byteCount: number
  provenance: string
}

export type AgentPersistentWorkspacePublicationCopyV1 =
  | AgentPersistentWorkspaceTaskPublicationCopyV1
  | AgentPersistentWorkspaceFindingPublicationCopyV1
  | AgentPersistentWorkspaceObjectivePublicationCopyV1
  | AgentPersistentWorkspaceArtifactPublicationCopyV1

export interface AgentPersistentWorkspacePublicationV1 {
  version: 1
  id: string
  workspaceId: string
  userId: string
  chatId: string | null
  category: AgentPersistentWorkspacePublicationCategoryV1
  sourceId: string
  sourceRevision: number
  sourceDigest: string
  sourceProvenance: AgentPersistentWorkspacePublicationProvenanceV1
  sourceCreatedAt: number
  sourceUpdatedAt: number
  sourceDeletedAt: number | null
  sourceStatus: 'present' | 'deleted'
  copy: AgentPersistentWorkspacePublicationCopyV1
  copyDigest: string
  publishedAt: number
  publishedBy: string
  revision: 1
}

export interface AgentPersistentWorkspaceDeletionResultV1 {
  workspaceId: string
  deleted: true
  publicationCount: number
}

export interface AgentPersistentWorkspaceCreateInputV1 {
  chatId: string
  workspaceId?: string
  objective?: string
  metadata?: Partial<AgentPersistentWorkspaceMetadataV1>
  progress?: Partial<AgentPersistentWorkspaceProgressV1>
  quota?: Partial<AgentPersistentWorkspaceQuotaV1>
}

export interface AgentPersistentWorkspaceEditInputV1 {
  expectedRevision: number
  objective?: string
  metadata?: Partial<AgentPersistentWorkspaceMetadataV1>
  progress?: Partial<AgentPersistentWorkspaceProgressV1>
  record?: {
    kind: AgentPersistentWorkspaceRecordKindV1
    summary: string
    evidenceIds?: string[]
    provenance?: string | null
    taskId?: string | null
  }
}

export interface AgentPersistentWorkspaceTaskInputV1 {
  expectedRevision: number
  id?: string
  turnSessionId?: string | null
  title: string
  objective?: string
  required?: boolean
  dependencyIds?: string[]
}

export interface AgentPersistentWorkspaceTurnSessionInputV1 {
  expectedRevision: number
  turnSessionId: string
  phase?: AgentPersistentWorkspaceTurnPhaseV1
  status?: AgentPersistentWorkspaceTurnStatusV1
  outcome?: AgentPersistentWorkspaceTerminalOutcomeV1 | null
}

export interface AgentPersistentWorkspacePublicationInputV1 {
  expectedRevision: number
  category: AgentPersistentWorkspacePublicationCategoryV1
  sourceId: string
  sourceRevision?: number
}

export interface AgentPersistentWorkspaceContextV1 {
  workspaceId: string
  chatId?: string | null
  expectedRevision: number
}

export interface AgentPersistentWorkspaceStateV1 {
  status: 'idle' | 'loading' | 'ready' | 'error'
  availability: 'attached' | 'detached' | 'missing' | 'deleted' | 'unavailable'
  workspace: AgentPersistentWorkspaceV1 | null
  error: string | null
  requestEpoch: number
}

export interface AgentRuntimeSettingsProjectionV1 {
  version: 1
  chatId: string
  revision: number
  authoredMode: 'response' | 'agentic' | null
  effectiveMode: 'response' | 'agentic'
  source: 'one_turn' | 'chat_override' | 'preset_default' | 'response_fallback'
  authority: 'host' | 'preset' | 'chat' | 'owner' | 'fallback'
  scope: 'turn' | 'chat' | 'preset' | 'host'
  cap: string | number | null
  gate: string | null
}
