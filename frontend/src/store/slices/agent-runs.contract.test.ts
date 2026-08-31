import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import type {
  AgentInspectionSectionAvailabilityV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionPageV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentRunPublicErrorV2,
} from '@/types/agent-runs'
import {
  createAgentRunsSlice,
  normalizeAgentRunInspectionDetailV1,
  normalizeAgentRunInspectionListV1,
  normalizeAgentRunInspectionRetryResponseV1,
  normalizeAgentRunStopResultV2,
  normalizePersistentWorkspace,
  normalizePersistentWorkspaceCollection,
  normalizePersistentWorkspaceTurnSessionPage,
  selectPersistentWorkspaceCollection,
} from './agent-runs'

type TestStore = Pick<AppStore, 'activeChatId'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))

const inspectionSections: AgentInspectionSectionAvailabilityV1[] = [
  { section: 'run', state: 'available', reason: null },
  { section: 'activity', state: 'available', reason: null },
  { section: 'transcript', state: 'available', reason: null },
  { section: 'turn_session', state: 'available', reason: null },
  { section: 'usage', state: 'available', reason: null },
  { section: 'prompt', state: 'not_recorded', reason: 'none' },
  { section: 'cortex', state: 'withheld', reason: 'unavailable' },
  { section: 'council', state: 'unavailable', reason: 'unavailable' },
  { section: 'workspace', state: 'source_deleted', reason: 'stale_input' },
] satisfies AgentInspectionSectionAvailabilityV1[]

const attempt = {
  version: 1,
  attemptId: 'attempt-a',
  previousAttemptId: null,
  target: {
    chatId: 'chat-a',
    generationType: 'normal',
    messageId: 'message-a',
    swipeId: 0,
  },
  createdAt: 1_000,
}

const target = { messageId: 'message-a', swipeId: 0 }
const usageTotals = { inputTokens: 10, outputTokens: 2, totalTokens: 12, toolCalls: 0, childInvocations: 0 }

function inspectionDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const activity = {
    version: 1,
    attempt,
    lifecycle: 'WORK',
    status: 'running',
    outcome: null,
    reason: 'none',
    revision: 1,
    startedAt: 1_000,
    updatedAt: 1_100,
    terminalAt: null,
    target,
    milestones: [],
    usage: usageTotals,
    markers: [],
    reconciliation: 'authoritative',
  }
  return {
    version: 1,
    attempt,
    runId: 'run-a',
    turnSessionId: 'turn-session-a',
    generationId: 'generation-a',
    hostCorrelationId: 'host-correlation-a',
    lifecycle: 'WORK',
    status: 'running',
    outcome: null,
    reason: 'none',
    target,
    committedTarget: target,
    revision: 1,
    startedAt: 1_000,
    updatedAt: 1_100,
    terminalAt: null,
    activity,
    markerCount: 0,
    transcriptCount: 0,
    terminal: false,
    transcript: [],
    turnSession: [],
    markers: [],
    usageEvidence: [],
    usage: {
      version: 1,
      inspectionAttemptId: 'attempt-a',
      totals: usageTotals,
      layers: [],
      evidenceCount: 0,
      omittedEvidenceCount: 0,
    },
    error: null,
    promptEvidence: [],
    renderCrossings: [],
    cortexReceipts: [],
    councilReceipts: [],
    workspaceAssociations: [],
    stop: null,
    retry: { allowed: false, reason: 'none', targetValid: true, linkedAttemptId: 'attempt-a' },
    workSegments: null,
    sectionAvailability: inspectionSections,
    ...overrides,
  }
}

function workSegmentInspection(phaseId: string | null = 'research') {
  const usage = {
    providerDispatches: 1,
    providerInputTokens: 8,
    providerOutputTokens: 2,
    providerTotalTokens: 10,
    billedOutputTokens: 2,
    toolCalls: 1,
    workspaceOperations: 1,
    unsignedBoundaries: 0,
    receiveBytes: 48,
    publishedOutputBytes: 0,
  }
  const identity = { segmentId: 'segment-a', phaseId, phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 0 }
  return {
    recovery: {
      state: 'closed',
      phaseId: null,
      phaseIndex: null,
      phaseOccurrence: null,
      nextSegmentOrdinal: 1,
      currentSegmentId: null,
      workspaceRevision: 3,
      terminalCloseResult: null,
      terminalBoundaryClass: null,
      usage: { ...usage, segments: 1 },
    },
    segments: [{
      identity,
      lifecycle: 'closed',
      workspaceRevision: 2,
      boundaryClass: 'tool_free_stop',
      closeResult: 'work_complete',
      closedWorkspaceRevision: 3,
      usage,
    }],
    dispatches: [{
      dispatchId: 'dispatch-a',
      segmentId: 'segment-a',
      dispatchOrdinal: 0,
      lifecycle: 'settled',
      toolMode: 'required',
      budgetClass: 'normal',
      workspaceRevision: 2,
      settledWorkspaceRevision: 3,
      boundaryClass: 'tool_free_stop',
      usage,
    }],
    transitions: [{
      transitionId: 'transition-a',
      handoffId: 'handoff-a',
      transitionKind: 'terminal',
      sourceSegment: identity,
      sourceWorkspaceRevision: 3,
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
      cause: 'tool_free_stop',
    }],
  }
}

function activeWorkSegmentInspection(phaseId: string | null = 'research') {
  const projection = workSegmentInspection(phaseId)
  return {
    ...projection,
    recovery: {
      ...projection.recovery,
      state: 'active',
      phaseId,
      phaseIndex: 0,
      phaseOccurrence: 0,
      nextSegmentOrdinal: 0,
      currentSegmentId: 'segment-a',
      terminalCloseResult: null,
      terminalBoundaryClass: null,
    },
    segments: projection.segments.map((segment) => ({
      ...segment,
      lifecycle: 'running',
      boundaryClass: null,
      closeResult: null,
      closedWorkspaceRevision: null,
    })),
    dispatches: projection.dispatches.map((dispatch) => ({
      ...dispatch,
      lifecycle: 'in_flight',
      settledWorkspaceRevision: null,
      boundaryClass: null,
      usage: null,
    })),
    transitions: [],
  }
}

function advancingWorkSegmentInspection() {
  const projection = workSegmentInspection('research')
  return {
    ...projection,
    recovery: {
      ...projection.recovery,
      state: 'active',
      phaseId: 'draft',
      phaseIndex: 1,
      phaseOccurrence: 0,
      nextSegmentOrdinal: 1,
      currentSegmentId: null,
      terminalCloseResult: null,
      terminalBoundaryClass: null,
    },
    segments: projection.segments.map((segment) => ({
      ...segment,
      closeResult: 'phase_advanced',
    })),
    transitions: projection.transitions.map((transition) => ({
      ...transition,
      transitionKind: 'advance',
      targetPhaseId: 'draft',
      targetPhaseIndex: 1,
      targetPhaseOccurrence: 0,
      targetSegmentOrdinal: 1,
    })),
  }
}

function retryResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    accepted: false,
    attempt: null,
    reason: 'needs_attention',
    recoveryEligible: true,
    recoveryAction: 'repair',
    inspectionAttemptId: 'attempt-a',
    ...overrides,
  }
}

function submission(state: 'submitted' | 'accepted' | 'rejected', id: string): AgentPersistentWorkspaceSubmissionV1 {
  return {
    version: 1,
    id,
    workspaceId: 'workspace-a',
    turnSessionId: null,
    taskId: `task-${id}`,
    userId: 'user-a',
    chatId: null,
    state,
    summary: `Result ${state}`,
    resultDigest: `digest-${id}`,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
  } satisfies AgentPersistentWorkspaceSubmissionV1
}
function persistentWorkspace(overrides: Partial<AgentPersistentWorkspaceV1> = {}): AgentPersistentWorkspaceV1 {
  return {
    version: 1,
    id: 'workspace-a',
    userId: 'user-a',
    chatId: 'chat-a',
    objective: 'Maintain the durable workspace',
    metadata: { title: 'Workspace A', summary: 'Durable state', labels: [], ownerNote: '' },
    progress: { state: 'in_progress', percent: 50, summary: 'In progress', updatedAt: 1_100 },
    state: 'active',
    revision: 2,
    quota: { maxTasks: 10, maxRecords: 10, maxSubmissions: 10, maxArtifacts: 10, maxPublications: 10, maxBytes: 10_000 },
    usage: { taskCount: 1, recordCount: 0, submissionCount: 0, artifactCount: 0, publicationCount: 0, byteCount: 64 },
    createdAt: 1_000,
    updatedAt: 1_100,
    ...overrides,
  }
}
const inspectionCorrelation = {
  turnSessionId: 'turn-session-a',
  runId: 'run-a',
  attemptId: 'attempt-a',
  chatId: 'chat-a',
  generationId: 'generation-a',
  messageId: 'message-a',
  swipeId: 0,
  actorId: 'agent',
  recipientId: null,
  phase: 'WORK',
  taskId: null,
  toolId: null,
  parentId: null,
  hostCorrelationId: 'host-correlation-a',
  hostSequence: 1,
} as const

function stopResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    turnId: 'turn-a',
    generationId: 'generation-a',
    status: 'accepted',
    revision: 2,
    target: {
      chatId: 'chat-a',
      generationType: 'normal',
      messageId: 'message-a',
      swipeId: 0,
    },
    workPhase: 'WORK',
    workStatus: 'cancelling',
    workOutcome: null,
    reason: null,
    recoveryEligible: false,
    recoveryAction: 'none',
    omissionCount: 0,
    inspectionAttemptId: 'attempt-a',
    ...overrides,
  }
}

function transcriptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'transcript-a',
    kind: 'provider_exchange',
    actor: 'provider',
    recipient: null,
    correlation: { ...inspectionCorrelation },
    occurredAt: 1_000,
    durationMs: null,
    late: false,
    content: null,
    arguments: null,
    result: null,
    provider: null,
    errorReason: null,
    ...overrides,
  }
}

function loomInspection(
  condition?: unknown,
  effectiveText: unknown = null,
): Record<string, unknown> {
  return {
    version: 1,
    surface: 'WORK',
    checkpoint: 'WORK',
    items: [{
      entryId: 'loom-entry-a',
      bucket: 'workPolicy',
      destination: 'root_work',
      checkpoint: 'WORK',
      source: { kind: 'loom_block', blockId: 'block-a', presetRevision: 1, blockRevision: 1, promptOrder: 0 },
      ...(condition === undefined ? {} : { condition, conditionResult: 'true' }),
      effectiveText,
      required: true,
      ordinaryPromptSuppressed: true,
      outcome: { status: 'included', effectiveIndex: 0, reason: 'selected' },
    }],
    effectiveEntryIds: ['loom-entry-a'],
  }
}

function promptEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'prompt-evidence-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    destination: 'completion_handoff',
    promptOrder: 0,
    role: 'context',
    correlation: { ...inspectionCorrelation },
    included: true,
    content: 'Completion handoff evidence',
    contentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    omissionReason: null,
    nativeProvenance: null,
    loomInspection: null,
    ...overrides,
  }
}

function councilReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'council-a',
    requestId: 'council-request-a',
    checkpoint: 'WORK',
    required: true,
    startedAt: 1_000,
    completedAt: null,
    state: 'accepted',
    memberCount: 2,
    resultDigest: null,
    correlation: { ...inspectionCorrelation },
    reason: null,
    canonical: false,
    ...overrides,
  }
}
function cortexReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'cortex-a',
    requestId: 'cortex-request-a',
    attemptId: 'attempt-a',
    checkpoint: 'WORK',
    snapshotId: 'snapshot-a',
    sourceRevision: 1,
    revision: 1,
    scope: { chatId: 'chat-a', targetMessageId: 'message-a', targetSwipeId: 0 },
    required: false,
    startedAt: 1_000,
    completedAt: null,
    state: 'accepted',
    resultDigest: null,
    resultCount: 1,
    correlation: { ...inspectionCorrelation },
    reason: 'none',
    omission: { reason: 'unavailable', required: false, detail: null },
    canonical: false,
    ...overrides,
  }
}

function workspaceAssociation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'association-a',
    workspaceId: 'workspace-a',
    workspaceRevision: 1,
    relation: 'linked',
    objectKind: 'task',
    objectId: 'task-a',
    sourceRevision: 1,
    sourceDeleted: false,
    provenanceDigest: 'a'.repeat(64),
    correlation: { ...inspectionCorrelation },
    ...overrides,
  }
}


function publication(overrides: Partial<AgentPersistentWorkspacePublicationV1> = {}): AgentPersistentWorkspacePublicationV1 {
  return {
    version: 1,
    id: 'publication-a',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    chatId: 'chat-a',
    category: 'task',
    sourceId: 'task-a',
    sourceRevision: 1,
    sourceDigest: 'a'.repeat(64),
    sourceProvenance: {
      workspaceId: 'workspace-a',
      turnSessionId: null,
      attemptId: null,
      executionId: 'execution-a',
      sourceDigest: 'a'.repeat(64),
      sourceChatId: 'chat-a',
      sourceMessageId: 'message-a',
      sourceSwipeId: 0,
      sourceDeletedAt: null,
      creator: 'host',
      capturedAt: 1_000,
    },
    sourceCreatedAt: 1_000,
    sourceUpdatedAt: 1_100,
    sourceDeletedAt: null,
    sourceStatus: 'present',
    copy: {
      category: 'task',
      id: 'task-a',
      title: 'Task A',
      objective: 'Complete task A',
      state: 'completed',
      required: true,
      dependencyIds: [],
      progress: { state: 'completed', percent: 100, summary: 'Done', updatedAt: 1_100 },
      summary: 'Task A complete',
    },
    copyDigest: 'b'.repeat(64),
    publishedAt: 1_100,
    publishedBy: 'host',
    revision: 1,
    ...overrides,
  }
}
function detachedSession(): AgentPersistentWorkspaceTurnSessionV1 {
  return {
    version: 1,
    id: 'session-detached',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    chatId: null,
    turnId: 'turn-detached',
    attemptId: 'attempt-detached',
    executionId: null,
    phase: 'TERMINAL',
    status: 'terminal',
    outcome: 'completed',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
    terminalAt: 1_100,
  }
}

function detachedTask(): AgentPersistentWorkspaceTaskV1 {
  return {
    version: 1,
    id: 'task-detached',
    workspaceId: 'workspace-a',
    turnSessionId: 'session-detached',
    userId: 'user-a',
    chatId: null,
    title: 'Detached task',
    objective: 'Preserve historical task',
    state: 'completed',
    required: true,
    dependencyIds: [],
    creator: 'host',
    hostAdmitted: true,
    progress: {
      state: 'completed',
      percent: 100,
      summary: 'Done',
      updatedAt: 1_100,
    },
    summary: 'Completed before chat deletion',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
  }
}

function detachedRecord(): Record<string, unknown> {
  return {
    version: 1,
    id: 'record-detached',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    chatId: null,
    turnSessionId: null,
    kind: 'finding',
    content: { summary: 'Historical finding', evidenceIds: [], provenance: null },
    taskId: null,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
  }
}

function detachedArtifact(): Record<string, unknown> {
  return {
    version: 1,
    id: 'artifact-detached',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    chatId: null,
    turnSessionId: null,
    blobDigest: 'blob-digest',
    mimeType: 'text/plain',
    byteCount: 1,
    provenance: 'Historical artifact',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
  }
}

beforeEach(() => {
  useStore.setState({
    activeChatId: 'chat-a',
    agentRunInspectionByAttemptId: {},
    agentRunInspectionListByChat: {},
    agentRunInspectionRequestEpochByKey: {},
    agentRunRetryByAttemptId: {},
    agentPersistentWorkspaceByChat: {},
    agentPersistentWorkspaceById: {},
    agentPersistentWorkspaceRequestEpochByKey: {},
    agentPersistentWorkspaceCollectionsById: {},
  })
})

describe('strict owner inspection contracts', () => {
  test('accepts aggregate usage layers without evidence-record ids', () => {
    const detail = inspectionDetail()
    detail.usage = {
      version: 1,
      inspectionAttemptId: 'attempt-a',
      totals: usageTotals,
      layers: [{
        version: 1,
        layer: 'root',
        source: 'final',
        correlation: null,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        toolCalls: 0,
        childInvocations: 0,
        evidenceIds: [],
        canonical: true,
      }],
      evidenceCount: 0,
      omittedEvidenceCount: 0,
    }

    expect(normalizeAgentRunInspectionDetailV1(detail)?.usage.layers).toEqual([
      expect.objectContaining({ layer: 'root', source: 'final', totalTokens: 12 }),
    ])
  })

  test('accepts custom and built-in WORK identities while rejecting private recovery authority', () => {
    const custom = normalizeAgentRunInspectionDetailV1(inspectionDetail({ workSegments: workSegmentInspection('research') }))
    expect(custom?.workSegments?.segments[0]?.identity.phaseId).toBe('research')
    expect(custom?.workSegments?.transitions[0]).toMatchObject({ handoffId: 'handoff-a', transitionKind: 'terminal' })

    const builtIn = normalizeAgentRunInspectionDetailV1(inspectionDetail({ workSegments: workSegmentInspection(null) }))
    expect(builtIn?.workSegments?.segments[0]?.identity.phaseId).toBeNull()
    expect(JSON.stringify(builtIn?.workSegments)).not.toMatch(/resumeEnvelope|credentialSecretRef|effectiveEndpoint|fingerprint|snapshot|generationParameters|resumeInput|userInput|regenFeedback|decisionAuthority|providerTransientCarrier/)

    const hostile = workSegmentInspection(null)
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...hostile,
        recovery: {
          ...hostile.recovery,
          resumeEnvelope: { credentialSecretRef: 'secret-ref', userInput: 'private prompt' },
        },
      },
    }))).toBeNull()
  })

  test('rejects incoherent WORK recovery, segment, and dispatch state unions', () => {
    const active = activeWorkSegmentInspection()
    const closed = workSegmentInspection()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ workSegments: active }))).not.toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: { ...active, recovery: { ...active.recovery, state: 'closed' } },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: { ...closed, recovery: { ...closed.recovery, state: 'active' } },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...active,
        recovery: { ...active.recovery, terminalCloseResult: 'failed' },
      },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...active,
        segments: active.segments.map((segment) => ({ ...segment, closeResult: 'failed' })),
      },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...active,
        dispatches: active.dispatches.map((dispatch) => ({ ...dispatch, settledWorkspaceRevision: 3 })),
      },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...closed,
        dispatches: closed.dispatches.map((dispatch) => ({ ...dispatch, usage: null })),
      },
    }))).toBeNull()
  })

  test('rejects terminal transitions with targets and advances without targets', () => {
    const terminal = workSegmentInspection()
    const advancing = advancingWorkSegmentInspection()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ workSegments: advancing }))).not.toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...terminal,
        transitions: terminal.transitions.map((transition) => ({
          ...transition,
          targetPhaseId: 'draft',
          targetPhaseIndex: 1,
          targetPhaseOccurrence: 0,
          targetSegmentOrdinal: 1,
        })),
      },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workSegments: {
        ...advancing,
        transitions: advancing.transitions.map((transition) => ({
          ...transition,
          targetPhaseId: null,
          targetPhaseIndex: null,
          targetPhaseOccurrence: null,
          targetSegmentOrdinal: null,
        })),
      },
    }))).toBeNull()
  })

  test('rejects missing WORK references and non-contiguous local ordinals', () => {
    const active = activeWorkSegmentInspection()
    const closed = workSegmentInspection()
    const advancing = advancingWorkSegmentInspection()
    const invalidProjections = [
      { ...active, recovery: { ...active.recovery, currentSegmentId: 'missing-segment' } },
      { ...closed, dispatches: closed.dispatches.map((dispatch) => ({ ...dispatch, segmentId: 'missing-segment' })) },
      {
        ...closed,
        transitions: closed.transitions.map((transition) => ({
          ...transition,
          sourceSegment: { ...transition.sourceSegment, segmentId: 'missing-segment' },
        })),
      },
      {
        ...closed,
        segments: closed.segments.map((segment) => ({
          ...segment,
          identity: { ...segment.identity, segmentOrdinal: 1 },
        })),
      },
      { ...closed, dispatches: closed.dispatches.map((dispatch) => ({ ...dispatch, dispatchOrdinal: 1 })) },
      { ...closed, recovery: { ...closed.recovery, nextSegmentOrdinal: 2 } },
      {
        ...advancing,
        transitions: advancing.transitions.map((transition) => ({ ...transition, targetSegmentOrdinal: 2 })),
      },
      {
        ...closed,
        recovery: { ...closed.recovery, usage: { ...closed.recovery.usage, segments: 2 } },
      },
    ]
    for (const workSegments of invalidProjections) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ workSegments }))).toBeNull()
    }
  })

  test('normalizes detail-only section availability as the canonical nine-entry projection', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail())

    expect(normalized?.sectionAvailability).toEqual(inspectionSections)
    expect(normalized?.sectionAvailability).toHaveLength(9)
  })

  test('rejects inspection detail that omits required WORK segment authority', () => {
    const detail = inspectionDetail()
    delete detail.workSegments

    expect(normalizeAgentRunInspectionDetailV1(detail)).toBeNull()
  })

  test('keeps a normal source target distinct from the committed Response target', () => {
    const detachedAttempt = {
      ...attempt,
      target: { ...attempt.target, messageId: null, swipeId: null },
    }
    const detail = inspectionDetail()
    const activity = detail.activity
    if (!activity || typeof activity !== 'object') throw new Error('inspection activity fixture is invalid')
    const normalized = normalizeAgentRunInspectionDetailV1({
      ...detail,
      attempt: detachedAttempt,
      target: null,
      activity: {
        ...activity,
        attempt: detachedAttempt,
        target: null,
      },
      committedTarget: { messageId: 'response-a', swipeId: 0 },
    })

    expect(normalized?.target).toBeNull()
    expect(normalized?.committedTarget).toEqual({ messageId: 'response-a', swipeId: 0 })
  })

  test('rejects section aliases, unknown states, and duplicate detail sections', () => {
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: inspectionSections.map((entry) => entry.section === 'turn_session'
        ? { ...entry, section: 'turnSession' }
        : entry),
    }))).toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: inspectionSections.map((entry) => entry.section === 'activity'
        ? { ...entry, state: 'recorded' }
        : entry),
    }))).toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: [...inspectionSections, inspectionSections[0]],
    }))).toBeNull()
  })
  test('rejects malformed or oversized inspection detail collections before render', () => {
    for (const key of ['transcript', 'turnSession', 'promptEvidence', 'cortexReceipts', 'councilReceipts', 'workspaceAssociations']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ [key]: [{ hostile: true }] }))).toBeNull()
    }
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: Array.from({ length: 4_097 }, () => null),
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail(), 'attempt-other')).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail(), 'attempt-a', 'chat-other')).toBeNull()
  })
  test('preserves native provenance and ordered render crossings', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [promptEvidence({
        sourceRevision: 'world-revision-7',
        nativeProvenance: {
          kind: 'world_info',
          sourceId: 'world-entry-a',
          sourceRevision: 'world-revision-7',
          sourceIndex: 2,
        },
      })],
      renderCrossings: [{
        version: 1,
        id: 'crossing-a',
        kind: 'accepted_finding',
        sourceId: 'finding-a',
        sourceRevision: 4,
        contentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        content: 'Accepted finding',
        correlation: { ...inspectionCorrelation },
      }],
    }))
    expect(normalized?.promptEvidence[0]?.nativeProvenance).toEqual({
      kind: 'world_info',
      sourceId: 'world-entry-a',
      sourceRevision: 'world-revision-7',
      sourceIndex: 2,
    })
    expect(normalized?.renderCrossings).toHaveLength(1)
    expect(normalized?.renderCrossings[0]).toMatchObject({ kind: 'accepted_finding', sourceId: 'finding-a', content: 'Accepted finding' })
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      renderCrossings: [{
        version: 1,
        id: 'crossing-a',
        kind: 'accepted_finding',
        sourceId: 'finding-a',
        sourceRevision: 4,
        contentDigest: 'not-a-sha256',
        content: 'Accepted finding',
        correlation: { ...inspectionCorrelation },
      }],
    }))).toBeNull()
  })
  test('uses source, revision, order, and destination as prompt occurrence identity', () => {
    const distinctOccurrences = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [
        promptEvidence({ id: 'prompt-three', sourceId: 'shared-source', sourceRevision: 7, promptOrder: 3, role: 'system', content: 'SYSTEM OCCURRENCE' }),
        promptEvidence({ id: 'prompt-seven', sourceId: 'shared-source', sourceRevision: 7, promptOrder: 7, role: 'user', content: 'USER OCCURRENCE', contentDigest: 'b'.repeat(64) }),
      ],
    }))
    expect(distinctOccurrences?.promptEvidence.map(({ promptOrder, role, content }) => ({ promptOrder, role, content }))).toEqual([
      { promptOrder: 3, role: 'system', content: 'SYSTEM OCCURRENCE' },
      { promptOrder: 7, role: 'user', content: 'USER OCCURRENCE' },
    ])

    const distinctDestinations = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [
        promptEvidence({ id: 'root-occurrence', sourceId: 'shared-source', sourceRevision: 7, destination: 'root_work' }),
        promptEvidence({ id: 'render-occurrence', sourceId: 'shared-source', sourceRevision: 7, destination: 'render' }),
      ],
    }))
    expect(distinctDestinations?.promptEvidence.map((evidence) => evidence.destination)).toEqual(['root_work', 'render'])

    const repeatedCanonicalEvidence = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [
        promptEvidence({ id: 'canonical-a', sourceId: 'shared-source', sourceRevision: 7 }),
        promptEvidence({
          id: 'canonical-b',
          sourceId: 'shared-source',
          sourceRevision: 7,
          correlation: { ...inspectionCorrelation, hostSequence: 2 },
        }),
      ],
    }))
    expect(repeatedCanonicalEvidence?.promptEvidence).toHaveLength(2)

    const missingOrder = promptEvidence()
    delete missingOrder.promptOrder
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ promptEvidence: [missingOrder] }))).toBeNull()
    for (const promptOrder of [-1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        promptEvidence: [promptEvidence({ promptOrder })],
      }))).toBeNull()
    }
  })

  test('rejects contradictory canonical evidence for one prompt occurrence', () => {
    const occurrence = { sourceId: 'collision', sourceRevision: 2, promptOrder: 0, destination: 'root_work' }
    const normalizeContradiction = (override: Record<string, unknown>) => normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [
        promptEvidence({ ...occurrence, id: 'collision-a' }),
        promptEvidence({ ...occurrence, id: 'collision-b', ...override }),
      ],
    }))

    expect(normalizeContradiction({ role: 'system' })).toBeNull()
    expect(normalizeContradiction({ content: 'Contradictory content' })).toBeNull()
    expect(normalizeContradiction({ contentDigest: 'b'.repeat(64) })).toBeNull()
    expect(normalizeContradiction({ included: false })).toBeNull()
    expect(normalizeContradiction({ omissionReason: 'not selected' })).toBeNull()
    expect(normalizeContradiction({
      nativeProvenance: { kind: 'world_info', sourceId: 'world-a', sourceRevision: 2, sourceIndex: 0 },
    })).toBeNull()
    expect(normalizeContradiction({ loomInspection: loomInspection() })).toBeNull()
  })

  test('accepts nullable transcript payloads, omitted Loom text, and completion-handoff evidence', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: [transcriptRecord()],
      promptEvidence: [promptEvidence({ loomInspection: loomInspection() })],
    }))

    expect(normalized?.transcript[0]).toMatchObject({
      content: null,
      arguments: null,
      result: null,
      provider: null,
    })
    expect(normalized?.promptEvidence[0]).toMatchObject({ destination: 'completion_handoff' })
    expect(normalized?.promptEvidence[0]?.loomInspection?.items[0]?.effectiveText).toBeNull()

    const missingContent = transcriptRecord()
    delete missingContent.content
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ transcript: [missingContent] }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      promptEvidence: [promptEvidence({ destination: 'completion' })],
    }))).toBeNull()
  })
  test('rejects malformed present nullable inspection fields instead of treating them as detached', () => {
    const withTranscript = (record: Record<string, unknown>) => normalizeAgentRunInspectionDetailV1(
      inspectionDetail({ transcript: [record] }),
    )
    const validNullableProvider = {
      adapter: 'openai',
      providerId: null,
      modelId: null,
      connectionId: 'frozen-connection',
      configRevision: 17,
      connectionRevision: null,
      fingerprint: null,
    }
    expect(withTranscript(transcriptRecord({ provider: validNullableProvider }))).not.toBeNull()
    expect(withTranscript(transcriptRecord({ provider: validNullableProvider }))?.transcript[0]?.provider).toMatchObject({
      connectionId: 'frozen-connection',
      configRevision: 17,
    })

    for (const messageId of ['', 42, 'x'.repeat(257)]) {
      expect(withTranscript(transcriptRecord({
        correlation: { ...inspectionCorrelation, messageId },
      }))).toBeNull()
    }
    for (const swipeId of [-1, '0']) {
      expect(withTranscript(transcriptRecord({
        correlation: { ...inspectionCorrelation, swipeId },
      }))).toBeNull()
    }
    for (const durationMs of [-1, '0']) {
      expect(withTranscript(transcriptRecord({ durationMs }))).toBeNull()
    }
    for (const field of ['content', 'arguments', 'result']) {
      for (const value of [42, 'x'.repeat(64 * 1024 + 1)]) {
        expect(withTranscript(transcriptRecord({ [field]: value }))).toBeNull()
      }
    }
    for (const providerId of [42, 'x'.repeat(129)]) {
      expect(withTranscript(transcriptRecord({
        provider: { ...validNullableProvider, providerId },
      }))).toBeNull()
    }
    for (const terminalAt of [-1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ terminalAt }))).toBeNull()
    }
    for (const omissionReason of [42, 'x'.repeat(2_049)]) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        promptEvidence: [promptEvidence({ omissionReason })],
      }))).toBeNull()
    }
    for (const sourceRevision of [-1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        workspaceAssociations: [workspaceAssociation({ sourceRevision })],
      }))).toBeNull()
    }

    const baseActivity = inspectionDetail().activity as Record<string, unknown>
    const marker = {
      version: 1,
      id: 'marker-a',
      kind: 'reconnect_gap',
      scope: 'activity',
      correlation: null,
      firstSequence: null,
      lastSequence: null,
      recoverable: null,
      detail: null,
    }
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      activity: { ...baseActivity, markers: [marker] },
    }))).not.toBeNull()
    for (const firstSequence of [-1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        activity: { ...baseActivity, markers: [{ ...marker, firstSequence }] },
      }))).toBeNull()
    }

    const milestone = {
      version: 1,
      id: 'milestone-a',
      parentId: null,
      kind: 'root',
      actor: 'host',
      phase: 'WORK',

      status: 'running',
      label: 'Root',
      toolId: null,
      taskId: null,
      sequence: 0,
      startedAt: 1_000,
      endedAt: null,
      elapsedMs: null,
      usage: null,
      correlation: { ...inspectionCorrelation },
    }
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      activity: { ...baseActivity, milestones: [milestone] },
    }))).not.toBeNull()
    for (const endedAt of [-1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        activity: { ...baseActivity, milestones: [{ ...milestone, endedAt }] },
      }))).toBeNull()
    }
  })
  test('binds detail activity, correlations, and inspection identity exactly', () => {
    const baseActivity = inspectionDetail().activity as Record<string, unknown>
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: [transcriptRecord({ correlation: { ...inspectionCorrelation, hostCorrelationId: 'host-other' } })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: [transcriptRecord({ correlation: { ...inspectionCorrelation, attemptId: 'attempt-other' } })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: [transcriptRecord({ correlation: { ...inspectionCorrelation, messageId: 'message-other' } })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      transcript: [transcriptRecord({ correlation: { ...inspectionCorrelation, runId: 'run-other' } })],
      promptEvidence: [promptEvidence()],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      activity: {
        ...baseActivity,
        attempt: { ...attempt, target: { ...attempt.target, chatId: 'chat-other' } },
      },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      activity: { ...baseActivity, target: { messageId: 'message-other', swipeId: 0 } },
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      usage: { ...(inspectionDetail().usage as Record<string, unknown>), inspectionAttemptId: 'attempt-other' },
    }))).toBeNull()

    const maxDate = 8_640_000_000_000_000
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ startedAt: maxDate }))).not.toBeNull()
    for (const startedAt of [maxDate + 1, Number.MAX_SAFE_INTEGER, -1, '0']) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ startedAt }))).toBeNull()
    }
  })

  test('accepts Cortex detached targets only as explicit nulls', () => {
    const nullAttempt = { ...attempt, target: { ...attempt.target, messageId: null, swipeId: null } }
    const nullCorrelation = { ...inspectionCorrelation, messageId: null, swipeId: null }
    const baseActivity = inspectionDetail().activity as Record<string, unknown>
    const detachedDetail = (scope: Record<string, unknown>) => inspectionDetail({
      attempt: nullAttempt,
      target: null,
      committedTarget: null,
      activity: { ...baseActivity, attempt: nullAttempt, target: null },
      cortexReceipts: [cortexReceipt({ scope, correlation: nullCorrelation })],
    })
    expect(normalizeAgentRunInspectionDetailV1(detachedDetail({
      chatId: 'chat-a',
      targetMessageId: null,
      targetSwipeId: null,
    }))).not.toBeNull()
    for (const targetMessageId of ['', 42, 'x'.repeat(257), undefined]) {
      expect(normalizeAgentRunInspectionDetailV1(detachedDetail({
        chatId: 'chat-a',
        targetMessageId,
        targetSwipeId: null,
      }))).toBeNull()
    }
    for (const targetSwipeId of [-1, '0', undefined]) {
      expect(normalizeAgentRunInspectionDetailV1(detachedDetail({
        chatId: 'chat-a',
        targetMessageId: null,
        targetSwipeId,
      }))).toBeNull()
    }
  })


  test('rejects inspection list rows with foreign chat or malformed sparse payloads', () => {
    const valid = { version: 1, chatId: 'chat-a', runs: [inspectionDetail()], nextCursor: null, omission: null }
    expect(normalizeAgentRunInspectionListV1(valid)).not.toBeNull()
    expect(normalizeAgentRunInspectionListV1({
      ...valid,
      runs: [{ ...inspectionDetail(), attempt: { ...attempt, target: { ...attempt.target, chatId: 'chat-b' } } }],
    })).toBeNull()
    const sparse = [inspectionDetail()]
    delete sparse[0]
    expect(normalizeAgentRunInspectionListV1({ ...valid, runs: sparse })).toBeNull()
    expect(normalizeAgentRunInspectionListV1({ ...valid, runs: Array.from({ length: 65 }, () => inspectionDetail()) })).toBeNull()
    expect(normalizeAgentRunInspectionListV1({ ...valid, runs: [{ hostile: true }] })).toBeNull()
  })

  test('strictly validates stop receipts against the requested identities', () => {
    expect(normalizeAgentRunStopResultV2(stopResult(), 'turn-a', 'chat-a', 'generation-a')).toMatchObject({
      turnId: 'turn-a',
      target: { chatId: 'chat-a' },
    })
    expect(normalizeAgentRunStopResultV2(stopResult({ turnId: 'turn-b' }), 'turn-a', 'chat-a', 'generation-a')).toBeNull()
    expect(normalizeAgentRunStopResultV2(stopResult({ status: 'unknown' }), 'turn-a', 'chat-a', 'generation-a')).toBeNull()
    expect(normalizeAgentRunStopResultV2(stopResult({ reason: undefined }), 'turn-a', 'chat-a', 'generation-a')).toBeNull()
    expect(normalizeAgentRunStopResultV2({ ...stopResult(), generationId: 'generation-b' }, 'turn-a', 'chat-a', 'generation-a')).toBeNull()
    const omittedGeneration = { ...stopResult() }
    delete omittedGeneration.generationId
    expect(normalizeAgentRunStopResultV2(omittedGeneration, 'turn-a', 'chat-a', 'generation-a')).toBeNull()
    const stopError = {
      version: 1,
      code: 'retry_unavailable',
      category: 'provider',
      summaryCode: 'retry_unavailable',
      recoveryEligible: false,
      recoveryAction: 'none',
      target: { chatId: 'chat-a', generationType: 'normal', messageId: 'message-a', swipeId: 0 },
      workPhase: 'WORK',
      workStatus: 'cancelling',
      workOutcome: null,
      reason: null,
      omissionCount: 0,
      inspectionAttemptId: 'attempt-a',
    }
    expect(normalizeAgentRunStopResultV2(stopResult({ error: stopError }), 'turn-a', 'chat-a', 'generation-a')).not.toBeNull()
    expect(normalizeAgentRunStopResultV2(stopResult({
      error: { ...stopError, target: { ...stopError.target, messageId: 'message-other' } },
    }), 'turn-a', 'chat-a', 'generation-a')).toBeNull()
  })

  test('requires explicit null or bounded identifiers for workspace associations', () => {
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workspaceAssociations: [workspaceAssociation({ objectId: null })],
    }))).not.toBeNull()
    for (const value of ['', 'x'.repeat(257), 42]) {
      expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
        workspaceAssociations: [workspaceAssociation({ objectId: value })],
      }))).toBeNull()
    }
    const missing = workspaceAssociation()
    delete missing.objectId
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ workspaceAssociations: [missing] }))).toBeNull()
  })

  test('enforces UTF-8 predicate string, list, child, depth, and shared node budgets', () => {
    const detailForPredicate = (predicate: unknown) => inspectionDetail({
      promptEvidence: [promptEvidence({
        loomInspection: loomInspection(predicate),
      })],
    })
    const scalar = '😀'.repeat(1_024)
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'equals',
      value: scalar,
    }))).not.toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'equals',
      value: `${scalar}😀`,
    }))).toBeNull()

    const listAtByteLimit = Array.from({ length: 16 }, () => scalar)
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'equals',
      value: listAtByteLimit,
    }))).not.toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'equals',
      value: [...listAtByteLimit, scalar],
    }))).toBeNull()

    const listAtItemLimit = Array.from({ length: 256 }, (_, index) => index)
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'in',
      values: listAtItemLimit,
    }))).not.toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'preset_variable',
      name: 'preset',
      operator: 'in',
      values: [...listAtItemLimit, 256],
    }))).toBeNull()

    const childrenAtNodeLimit = Array.from({ length: 255 }, () => ({ kind: 'phase', value: 'WORK' }))
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'all',
      children: childrenAtNodeLimit,
    }))).not.toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate({
      kind: 'all',
      children: [...childrenAtNodeLimit, { kind: 'phase', value: 'WORK' }],
    }))).toBeNull()

    let depthAtLimit: unknown = { kind: 'phase', value: 'WORK' }
    for (let index = 1; index < 16; index += 1) depthAtLimit = { kind: 'not', child: depthAtLimit }
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate(depthAtLimit))).not.toBeNull()
    depthAtLimit = { kind: 'not', child: depthAtLimit }
    expect(normalizeAgentRunInspectionDetailV1(detailForPredicate(depthAtLimit))).toBeNull()
  })

  test('requires council receipt required evidence to be an actual boolean', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      councilReceipts: [councilReceipt()],
    }))
    expect(normalized?.councilReceipts[0]?.required).toBe(true)

    const missingRequired = councilReceipt()
    delete missingRequired.required
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({ councilReceipts: [missingRequired] }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      councilReceipts: [councilReceipt({ required: 'true' })],
    }))).toBeNull()
  })


  test('matches backend byte bounds for turn, Cortex, council, and workspace evidence', () => {
    const turnEntry = {
      version: 1,
      id: 'turn-entry-a',
      kind: 'input',
      correlation: { ...inspectionCorrelation },
      occurredAt: 1_000,
      detail: 'x'.repeat(2_048),
      transcriptRecordIds: [],
    }
    const cortex = cortexReceipt({
      resultDigest: 'd'.repeat(256),
      omission: { reason: 'unavailable', required: false, detail: 'x'.repeat(2_048) },
    })
    const council = councilReceipt({ resultDigest: 'd'.repeat(256) })
    const association = workspaceAssociation()
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      turnSession: [turnEntry],
      cortexReceipts: [cortex],
      councilReceipts: [council],
      workspaceAssociations: [association],
    }))
    expect(normalized).not.toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      turnSession: [{ ...turnEntry, detail: 'x'.repeat(2_049) }],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      cortexReceipts: [cortexReceipt({ resultDigest: 'd'.repeat(257) })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      cortexReceipts: [cortexReceipt({
        omission: { reason: 'unavailable', required: false, detail: 'x'.repeat(2_049) },
      })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      councilReceipts: [councilReceipt({ resultDigest: 'd'.repeat(257) })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workspaceAssociations: [workspaceAssociation({ provenanceDigest: 'a'.repeat(63) })],
    }))).toBeNull()
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      workspaceAssociations: [workspaceAssociation({ provenanceDigest: 'a'.repeat(65) })],
    }))).toBeNull()
  })

  test('rejects retry aliases and unknown structured recovery actions', () => {
    expect(normalizeAgentRunInspectionRetryResponseV1(retryResponse({
      attempt: undefined,
      attemptId: 'attempt-a',
    }))).toBeNull()

    expect(normalizeAgentRunInspectionRetryResponseV1(retryResponse({
      recoveryAction: 'retryable',
    }))).toBeNull()
  })

  test('stores server recovery fields without inferring retryability locally', () => {
    const state = useStore.getState()
    const inspectionEpoch = state.beginAgentRunInspection('chat-a', 'attempt-a')
    expect(state.applyAgentRunInspection('chat-a', 'attempt-a', inspectionEpoch, inspectionDetail())).toBe(true)
    expect(useStore.getState().agentRunInspectionByAttemptId['attempt-a']?.detail?.retry).toEqual({
      allowed: false,
      reason: 'none',
      targetValid: true,
      linkedAttemptId: 'attempt-a',
    })

    useStore.getState().beginAgentRunRetry('attempt-a')
    expect(useStore.getState().applyAgentRunRetry('attempt-a', retryResponse({
      accepted: false,
      recoveryEligible: true,
      recoveryAction: 'retry',
    }))).toBe(true)
    expect(useStore.getState().agentRunRetryByAttemptId['attempt-a']).toMatchObject({
      status: 'refused',
      response: { accepted: false, recoveryEligible: true, recoveryAction: 'retry' },
    })
  })

  test('rejects stale inspection epochs before accepting the current detail', () => {
    const staleEpoch = useStore.getState().beginAgentRunInspection('chat-a', 'attempt-a')
    const currentEpoch = useStore.getState().beginAgentRunInspection('chat-a', 'attempt-a')

    expect(useStore.getState().applyAgentRunInspection('chat-a', 'attempt-a', staleEpoch, inspectionDetail())).toBe(false)
    expect(useStore.getState().agentRunInspectionByAttemptId['attempt-a']?.detail).toBeNull()
    expect(useStore.getState().applyAgentRunInspection('chat-a', 'attempt-a', currentEpoch, inspectionDetail())).toBe(true)
  })
})

describe('persistent workspace snapshot contracts', () => {
  test('terminalizes malformed snapshots while retaining the accepted workspace', () => {
    const firstEpoch = useStore.getState().beginPersistentWorkspaceRequest('chat:chat-a')
    expect(useStore.getState().applyPersistentWorkspace('chat:chat-a', firstEpoch, persistentWorkspace())).toBe(true)


    const invalidEpoch = useStore.getState().beginPersistentWorkspaceRequest('chat:chat-a')
    expect(useStore.getState().applyPersistentWorkspace('chat:chat-a', invalidEpoch, {
      version: 1,
      id: 'workspace-a',
      chatId: 'chat-a',
    })).toBe(false)

    expect(useStore.getState().agentPersistentWorkspaceByChat['chat-a']).toMatchObject({
      status: 'error',
      availability: 'unavailable',
      workspace: { id: 'workspace-a', revision: 2 },
      error: 'Invalid persistent workspace response',
    })
  })

  test('rejects an older workspace revision without replacing the newer state', () => {
    const firstEpoch = useStore.getState().beginPersistentWorkspaceRequest('chat:chat-a')
    expect(useStore.getState().applyPersistentWorkspace('chat:chat-a', firstEpoch, persistentWorkspace({ revision: 4 }))).toBe(true)

    const staleEpoch = useStore.getState().beginPersistentWorkspaceRequest('chat:chat-a')
    expect(useStore.getState().applyPersistentWorkspace('chat:chat-a', staleEpoch, persistentWorkspace({ revision: 3 }))).toBe(false)
    expect(useStore.getState().agentPersistentWorkspaceByChat['chat-a']).toMatchObject({
      status: 'ready',
      workspace: { id: 'workspace-a', revision: 4 },
    })
  })
  test('requires explicit null or a bounded non-empty chat identity', () => {
    const detached = persistentWorkspace({ chatId: null })
    expect(normalizePersistentWorkspace(detached)?.chatId).toBeNull()

    const missing: Record<string, unknown> = { ...detached }
    delete missing.chatId
    expect(normalizePersistentWorkspace(missing)).toBeNull()
    expect(normalizePersistentWorkspace({ ...detached, chatId: '' })).toBeNull()
    expect(normalizePersistentWorkspace({ ...detached, chatId: 42 })).toBeNull()
    const maxDateSeconds = 8_640_000_000_000
    const atDateBound = { ...detached, createdAt: maxDateSeconds, updatedAt: maxDateSeconds, progress: { ...detached.progress, updatedAt: maxDateSeconds } }
    expect(normalizePersistentWorkspace(atDateBound)).not.toBeNull()
    expect(normalizePersistentWorkspace({ ...atDateBound, updatedAt: maxDateSeconds + 1 })).toBeNull()
  })
})
  test('rejects malformed task and publication chat identities', () => {
    expect(normalizePersistentWorkspaceCollection('tasks', [{ ...detachedTask(), chatId: '' }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('tasks', [{ ...detachedTask(), chatId: 42 as unknown as string }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('tasks', [{ ...detachedTask(), chatId: 'x'.repeat(257) }], 'workspace-a')).toBeNull()

    const canonicalPublication = publication()
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceChatId: null },
    }], 'workspace-a')).toEqual([{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceChatId: null },
    }])
    expect(normalizePersistentWorkspaceCollection('publications', [{ ...canonicalPublication, chatId: '' }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('publications', [{ ...canonicalPublication, chatId: 'x'.repeat(257) }], 'workspace-a')).toBeNull()
    const malformedTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'tasks',
      malformedTaskEpoch,
      [{ ...detachedTask(), chatId: '' }],
    )).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'tasks')).toMatchObject({ items: [] })
    const malformedPublicationEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'publications')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'publications',
      malformedPublicationEpoch,
      [{ ...canonicalPublication, chatId: '' }],
    )).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'publications')).toMatchObject({ items: [] })
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceChatId: '' },
    }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceChatId: 42 as unknown as string },
    }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceChatId: 'x'.repeat(257) },
    }], 'workspace-a')).toBeNull()
  })

describe('persistent workspace collection contracts', () => {
  test('accepts all canonical submission states and preserves their DTOs', () => {
    const submissions = [
      submission('submitted', 'submission-submitted'),
      submission('accepted', 'submission-accepted'),
      submission('rejected', 'submission-rejected'),
    ] satisfies AgentPersistentWorkspaceSubmissionV1[]
    const workspaceEpoch = useStore.getState().beginPersistentWorkspaceRequest('id:workspace-a')
    expect(useStore.getState().applyPersistentWorkspace('id:workspace-a', workspaceEpoch, persistentWorkspace({ chatId: null }))).toBe(true)
    const epoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')

    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'submissions', epoch, submissions)).toBe(true)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'submissions')).toEqual({
      status: 'ready',
      items: submissions,
      error: null,
    })
  })
  test('rejects malformed present nullable collection identifiers', () => {
    const session = detachedSession()
    for (const value of ['', 'x'.repeat(257), 42]) {
      expect(normalizePersistentWorkspaceCollection('sessions', [{ ...session, executionId: value }], 'workspace-a')).toBeNull()
    }
    const task = detachedTask()
    for (const value of ['', 'x'.repeat(257), 42]) {
      expect(normalizePersistentWorkspaceCollection('tasks', [{ ...task, turnSessionId: value }], 'workspace-a')).toBeNull()
    }
    const record = detachedRecord()
    for (const field of ['turnSessionId', 'chatId', 'taskId']) {
      for (const value of ['', 'x'.repeat(257), 42]) {
        expect(normalizePersistentWorkspaceCollection('records', [{ ...record, [field]: value }], 'workspace-a')).toBeNull()
      }
    }
    const artifact = detachedArtifact()
    for (const field of ['turnSessionId', 'chatId']) {
      for (const value of ['', 'x'.repeat(257), 42]) {
        expect(normalizePersistentWorkspaceCollection('artifacts', [{ ...artifact, [field]: value }], 'workspace-a')).toBeNull()
      }
    }
    const detachedSubmission = submission('submitted', 'submission-detached')
    for (const field of ['turnSessionId', 'chatId']) {
      for (const value of ['', 'x'.repeat(257), 42]) {
        expect(normalizePersistentWorkspaceCollection('submissions', [{ ...detachedSubmission, [field]: value }], 'workspace-a')).toBeNull()
      }
    }
    const canonicalPublication = publication()
    for (const field of ['turnSessionId', 'attemptId', 'executionId', 'sourceChatId', 'sourceMessageId']) {
      for (const value of ['', 'x'.repeat(257), 42]) {
        expect(normalizePersistentWorkspaceCollection('publications', [{
          ...canonicalPublication,
          sourceProvenance: { ...canonicalPublication.sourceProvenance, [field]: value },
        }], 'workspace-a')).toBeNull()
      }
    }
    expect(normalizePersistentWorkspaceCollection('sessions', [{ ...session, executionId: null }], 'workspace-a')).not.toBeNull()
    expect(normalizePersistentWorkspaceCollection('tasks', [{ ...task, turnSessionId: null }], 'workspace-a')).not.toBeNull()
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...canonicalPublication,
      sourceProvenance: { ...canonicalPublication.sourceProvenance, sourceMessageId: null },
    }], 'workspace-a')).not.toBeNull()
    expect(normalizePersistentWorkspaceCollection('records', [record], 'workspace-a')).not.toBeNull()
    expect(normalizePersistentWorkspaceCollection('artifacts', [artifact], 'workspace-a')).not.toBeNull()
    expect(normalizePersistentWorkspaceCollection('submissions', [detachedSubmission], 'workspace-a')).not.toBeNull()
  })

  test('keeps accepted collection rows when stored workspace chat scope rejects a page', () => {
    const attached = persistentWorkspace()
    const attachedWorkspaceEpoch = useStore.getState().beginPersistentWorkspaceRequest('id:workspace-a')
    expect(useStore.getState().applyPersistentWorkspace('id:workspace-a', attachedWorkspaceEpoch, attached)).toBe(true)
    const validTask = { ...detachedTask(), id: 'task-attached', turnSessionId: null, chatId: 'chat-a' }
    const firstTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'tasks', firstTaskEpoch, [validTask])).toBe(true)
    const invalidTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'tasks', invalidTaskEpoch, [{ ...validTask, id: 'task-foreign', chatId: 'chat-b' }])).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'tasks')).toMatchObject({
      status: 'error',
      items: [validTask],
    })
    const nullTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'tasks', nullTaskEpoch, [{ ...validTask, id: 'task-detached', chatId: null }])).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'tasks')).toMatchObject({
      status: 'error',
      items: [validTask],
    })

    const detached = persistentWorkspace({ id: 'workspace-detached', chatId: null })
    const detachedWorkspaceEpoch = useStore.getState().beginPersistentWorkspaceRequest('id:workspace-detached')
    expect(useStore.getState().applyPersistentWorkspace('id:workspace-detached', detachedWorkspaceEpoch, detached)).toBe(true)
    const validSession = { ...detachedSession(), workspaceId: 'workspace-detached' }
    const firstSessionEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-detached', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-detached', 'sessions', firstSessionEpoch, {
      data: [validSession],
      total: 1,
      limit: 1,
      offset: 0,
    })).toBe(true)
    const invalidSessionEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-detached', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-detached', 'sessions', invalidSessionEpoch, {
      data: [{ ...validSession, id: 'session-foreign', chatId: 'chat-a' }],
      total: 1,
      limit: 1,
      offset: 0,
    })).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-detached', 'sessions')).toMatchObject({
      status: 'error',
      items: [validSession],
    })
  })
  test('rejects nonempty collections until the workspace chat scope is authoritative', () => {
    const unknownTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-unknown', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-unknown',
      'tasks',
      unknownTaskEpoch,
      [detachedTask()],
    )).toBe(false)
    const foreignTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-unknown', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-unknown',
      'tasks',
      foreignTaskEpoch,
      [{ ...detachedTask(), id: 'task-foreign', chatId: 'chat-a' }],
    )).toBe(false)
    const emptyTaskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-unknown', 'tasks')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-unknown', 'tasks', emptyTaskEpoch, [])).toBe(true)
    const emptySessionEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-unknown', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-unknown',
      'sessions',
      emptySessionEpoch,
      { data: [], total: 0, limit: 1, offset: 0 },
      false,
      0,
    )).toBe(true)
  })


  test('preserves detached session and task rows after source chat deletion', () => {
    const workspaceEpoch = useStore.getState().beginPersistentWorkspaceRequest('id:workspace-a')
    expect(useStore.getState().applyPersistentWorkspace('id:workspace-a', workspaceEpoch, persistentWorkspace({ chatId: null }))).toBe(true)
    const session = detachedSession()
    const task = detachedTask()
    const sessionEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    const taskEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'tasks')
    const firstPage: AgentPersistentWorkspaceTurnSessionPageV1 = { data: [session], total: 2, limit: 1, offset: 0 }

    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', sessionEpoch, firstPage)).toBe(true)
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'tasks', taskEpoch, [task])).toBe(true)

    const laterSession = { ...session, id: 'session-detached-later', turnId: 'turn-detached-later', attemptId: 'attempt-detached-later' }
    const laterEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', laterEpoch, {
      data: [laterSession],
      total: 2,
      limit: 1,
      offset: 1,
    }, true)).toBe(true)

    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'sessions')).toEqual({
      status: 'ready',
      items: [session, laterSession],
      error: null,
    })
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'tasks')).toEqual({
      status: 'ready',
      items: [task],
      error: null,
    })
    expect(useStore.getState().agentPersistentWorkspaceCollectionsById['workspace-a']?.sessionsPage).toEqual({ total: 2, limit: 1, offset: 1, nextOffset: 2 })
    expect(session.chatId).toBeNull()
    expect(task.chatId).toBeNull()
  })
  test('rejects session pages outside the bounded metadata contract', () => {
    const session = detachedSession()
    const invalidPages = [
      { data: [session], total: 1, limit: 0, offset: 0 },
      { data: [session, session], total: 2, limit: 1, offset: 0 },
      { data: [session], total: 1, limit: 1, offset: -1 },
      { data: [], total: 2, limit: 1, offset: 1 },
      { data: [session, { ...session, id: 'session-overflow' }], total: 1, limit: 2, offset: 0 },
    ]
    for (const payload of invalidPages) {
      const epoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
      expect(normalizePersistentWorkspaceTurnSessionPage(payload, 'workspace-a')).toBeNull()
      expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', epoch, payload)).toBe(false)
    }
    expect(normalizePersistentWorkspaceTurnSessionPage(
      { data: [session], total: 2, limit: 1, offset: 0 },
      'workspace-a',
      1,
    )).toBeNull()
  })

  test('rejects replayed pages without mutating accepted rows or paging progress', () => {
    const workspaceEpoch = useStore.getState().beginPersistentWorkspaceRequest('id:workspace-a')
    expect(useStore.getState().applyPersistentWorkspace('id:workspace-a', workspaceEpoch, persistentWorkspace({ chatId: null }))).toBe(true)
    const first = detachedSession()
    const second = { ...first, id: 'session-detached-second', turnId: 'turn-detached-second', attemptId: 'attempt-detached-second' }
    const third = { ...first, id: 'session-detached-third', turnId: 'turn-detached-third', attemptId: 'attempt-detached-third' }
    const firstEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', firstEpoch, {
      data: [first],
      total: 3,
      limit: 1,
      offset: 0,
    }, false, 0)).toBe(true)
    const secondPage = { data: [second], total: 3, limit: 1, offset: 1 }
    const secondEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', secondEpoch, secondPage, true, 1)).toBe(true)
    const thirdEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', thirdEpoch, {
      data: [third],
      total: 3,
      limit: 1,
      offset: 2,
    }, true, 2)).toBe(true)

    const metadataDriftPage = { data: [{ ...first, id: 'session-detached-fourth', turnId: 'turn-detached-fourth', attemptId: 'attempt-detached-fourth' }], total: 4, limit: 1, offset: 3 }
    const metadataEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', metadataEpoch, metadataDriftPage, true, 3)).toBe(false)
    const acceptedRows = selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'sessions')
    const acceptedPage = useStore.getState().agentPersistentWorkspaceCollectionsById['workspace-a']?.sessionsPage
    const replayEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'sessions')
    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'sessions', replayEpoch, secondPage, true, 1)).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'sessions')).toMatchObject({
      items: acceptedRows?.items,
    })
    expect(useStore.getState().agentPersistentWorkspaceCollectionsById['workspace-a']?.sessionsPage).toEqual(acceptedPage)
  })

  test('rejects unknown submission states and stale collection epochs', () => {
    const staleEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')
    const currentEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')

    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'submissions',
      staleEpoch,
      [submission('submitted', 'submission-stale')],
    )).toBe(false)

    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'submissions',
      currentEpoch,
      [{ ...submission('submitted', 'submission-invalid'), state: 'pending' }],
    )).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'submissions')).toMatchObject({
      status: 'error',
      items: [],
      error: 'Invalid persistent workspace collection response',
    })
  })
  test('rejects collection rows from a different workspace identity', () => {
    const epoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')
    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'submissions',
      epoch,
      [{ ...submission('submitted', 'submission-other'), workspaceId: 'workspace-other' }],
    )).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'submissions')).toMatchObject({
      status: 'error',
      items: [],
      error: 'Invalid persistent workspace collection response',
    })
  })
  test('accepts publication rows without common timestamps and requires publication provenance execution identity', () => {
    const withExecutionId = publication()
    expect(withExecutionId).not.toHaveProperty('createdAt')
    expect(withExecutionId).not.toHaveProperty('updatedAt')
    expect(normalizePersistentWorkspaceCollection('publications', [withExecutionId], 'workspace-a')).toEqual([withExecutionId])

    const withNullExecutionId = publication({
      sourceProvenance: { ...withExecutionId.sourceProvenance, executionId: null },
    })
    expect(normalizePersistentWorkspaceCollection('publications', [withNullExecutionId], 'workspace-a')).toEqual([withNullExecutionId])

    const missingExecutionId = { ...withExecutionId.sourceProvenance }
    delete missingExecutionId.executionId
    expect(normalizePersistentWorkspaceCollection('publications', [{
      ...withExecutionId,
      sourceProvenance: missingExecutionId,
    }], 'workspace-a')).toBeNull()
    expect(normalizePersistentWorkspaceCollection('publications', [publication({
      sourceProvenance: { ...withExecutionId.sourceProvenance, executionId: 42 as unknown as string },
    })], 'workspace-a')).toBeNull()
  })

  test('preserves public structured error DTOs instead of creating local aliases', () => {
    const error: AgentRunPublicErrorV2 = {
      code: 'retry_unavailable',
      category: 'provider',
      summaryCode: 'retry_unavailable',
      recoveryEligible: false,
      recoveryAction: 'resync',
      target: null,
      workPhase: 'WORK',
      workStatus: 'terminal',
      workOutcome: 'failed',
      reason: 'provider_failure',
      omissionCount: 0,
      inspectionAttemptId: 'attempt-a',
    }
    useStore.getState().failAgentRunRetry('attempt-a', error)
    expect(useStore.getState().agentRunRetryByAttemptId['attempt-a']).toMatchObject({
      status: 'error',
      error,
    })
  })
})
