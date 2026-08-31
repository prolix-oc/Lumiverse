import { expect, mock, spyOn, test } from 'bun:test'
import { createInstance } from 'i18next'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import type {
  AgentCortexReceiptV1,
  AgentCouncilReceiptV1,
  AgentInspectionMarkerV1,
  AgentInspectionTranscriptRecordV1,
  AgentInspectionUsageLayerV1,
  AgentInspectionUsageV1,
  AgentPersistentWorkspaceTurnSessionPageV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentPromptEvidenceV1,
  AgentRunInspectionDetailV1,
  AgentTurnSessionEntryV1,
  AgentWorkspaceAssociationV1,
} from '@/types/agent-runs'
import type { Root } from 'react-dom/client'

mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['common', 'auth', 'landing', 'chat', 'shared', 'commands', 'modals', 'panels', 'settings', 'weaver', 'errors'],
  fallbackLanguagesFor: (language: string) => language === 'zh-TW' ? ['zh-TW', 'zh', 'en'] : language === 'en' ? ['en'] : [language, 'en'],
  loadLanguageBundles: async () => {},
}))
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))

const detachedWorkspace: AgentPersistentWorkspaceV1 = {
  version: 1,
  id: 'workspace-detached',
  userId: 'user-a',
  chatId: null,
  objective: 'Preserve detached work',
  metadata: {
    title: 'Detached workspace',
    summary: 'Historical workspace',
    labels: [],
    ownerNote: '',
  },
  progress: {
    state: 'completed',
    percent: 100,
    summary: 'Complete',
    updatedAt: 1_100,
  },
  state: 'active',
  revision: 1,
  quota: {
    maxTasks: 10,
    maxRecords: 10,
    maxSubmissions: 10,
    maxArtifacts: 10,
    maxPublications: 10,
    maxBytes: 1_000_000,
  },
  usage: {
    taskCount: 1,
    recordCount: 0,
    submissionCount: 0,
    artifactCount: 0,
    publicationCount: 0,
    byteCount: 0,
  },
  createdAt: 1_000,
  updatedAt: 1_100,
}

const detachedSession: AgentPersistentWorkspaceTurnSessionV1 = {
  version: 1,
  id: 'session-detached',
  workspaceId: detachedWorkspace.id,
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
const boundedWorkspaceSessions: AgentPersistentWorkspaceTurnSessionPageV1 = {
  data: Array.from({ length: 40 }, (_, index): AgentPersistentWorkspaceTurnSessionV1 => ({
    ...detachedSession,
    id: `session-detached-${index}`,
    turnId: `turn-detached-${index}`,
    attemptId: `attempt-detached-${index}`,
  })),
  total: 40,
  limit: 50,
  offset: 0,
}
const detachedSessionPage: AgentPersistentWorkspaceTurnSessionPageV1 = {
  data: [detachedSession],
  total: 1,
  limit: 50,
  offset: 0,
}

const attempt = {
  version: 1 as const,
  attemptId: 'attempt-detached',
  previousAttemptId: null,
  target: {
    chatId: 'chat-deleted',
    generationType: 'normal' as const,
    messageId: 'message-a',
    swipeId: 0,
  },
  createdAt: 1_000,
}
const target = { messageId: 'message-a', swipeId: 0 }
const usageTotals = {
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  toolCalls: 0,
  childInvocations: 0,
}
const correlation = {
  turnSessionId: 'turn-detached',
  runId: 'run-detached',
  attemptId: attempt.attemptId,
  chatId: 'chat-deleted',
  generationId: 'generation-detached',
  messageId: 'message-a',
  swipeId: 0,
  actorId: 'agent',
  recipientId: null,
  phase: 'TERMINAL' as const,
  taskId: null,
  toolId: null,
  parentId: null,
  hostCorrelationId: 'host-correlation-detached',
  hostSequence: 1,
}

const sourceDeletedInspection: AgentRunInspectionDetailV1 = {
  version: 1,
  attempt,
  runId: 'run-detached',
  turnSessionId: 'turn-detached',
  generationId: 'generation-detached',
  hostCorrelationId: 'host-correlation-detached',
  lifecycle: 'TERMINAL',
  status: 'terminal',
  outcome: 'completed',
  reason: 'reconciled',
  target,
  committedTarget: target,
  revision: 1,
  startedAt: 1_000,
  updatedAt: 1_100,
  terminalAt: 1_100,
  activity: {
    version: 1,
    attempt,
    lifecycle: 'TERMINAL',
    status: 'terminal',
    outcome: 'completed',
    reason: 'reconciled',
    revision: 1,
    startedAt: 1_000,
    updatedAt: 1_100,
    terminalAt: 1_100,
    target,
    milestones: [],
    usage: usageTotals,
    markers: [],
    reconciliation: 'recovered',
  },
  markerCount: 0,
  transcriptCount: 0,
  terminal: true,
  transcript: [],
  turnSession: [],
  markers: [],
  usageEvidence: [],
  usage: {
    version: 1,
    inspectionAttemptId: attempt.attemptId,
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
  workSegments: null,
  workspaceAssociations: [{
    version: 1,
    id: 'association-detached',
    workspaceId: detachedWorkspace.id,
    workspaceRevision: detachedWorkspace.revision,
    relation: 'linked',
    objectKind: 'task',
    objectId: null,
    sourceRevision: null,
    sourceDeleted: true,
    provenanceDigest: null,
    correlation,
  }],
  stop: null,
  retry: {
    allowed: false,
    reason: 'reconciled',
    targetValid: true,
    linkedAttemptId: attempt.attemptId,
  },
  sectionAvailability: [{
    section: 'workspace',
    state: 'source_deleted',
    reason: 'stale_input',
  }],
}
const zeroWorkUsage = {
  providerDispatches: 1,
  providerInputTokens: 12,
  providerOutputTokens: 3,
  providerTotalTokens: 15,
  billedOutputTokens: 3,
  toolCalls: 1,
  workspaceOperations: 1,
  unsignedBoundaries: 0,
  receiveBytes: 64,
  publishedOutputBytes: 0,
}
const populatedWorkInspection: AgentRunInspectionDetailV1 = {
  ...sourceDeletedInspection,
  workSegments: {
    recovery: {
      state: 'closed',
      phaseId: null,
      phaseIndex: null,
      phaseOccurrence: null,
      nextSegmentOrdinal: 2,
      currentSegmentId: null,
      workspaceRevision: 4,
      terminalCloseResult: null,
      terminalBoundaryClass: 'tool_free_stop',
      usage: { ...zeroWorkUsage, segments: 2 },
    },
    segments: [{
      identity: { segmentId: 'segment-older', phaseId: null, phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 0 },
      lifecycle: 'closed',
      workspaceRevision: 2,
      boundaryClass: 'reasoning_only_length',
      closeResult: 'same_phase_rollover',
      closedWorkspaceRevision: 3,
      usage: zeroWorkUsage,
    }, {
      identity: { segmentId: 'segment-built-in', phaseId: null, phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 1 },
      lifecycle: 'closed',
      workspaceRevision: 3,
      boundaryClass: 'tool_free_stop',
      closeResult: 'work_complete',
      closedWorkspaceRevision: 4,
      usage: zeroWorkUsage,
    }],
    dispatches: [{
      dispatchId: 'dispatch-older-high-local-ordinal',
      segmentId: 'segment-older',
      dispatchOrdinal: 9,
      lifecycle: 'settled',
      toolMode: 'required',
      budgetClass: 'recovery',
      workspaceRevision: 2,
      settledWorkspaceRevision: 3,
      boundaryClass: 'reasoning_only_length',
      usage: zeroWorkUsage,
    }, {
      dispatchId: 'dispatch-final',
      segmentId: 'segment-built-in',
      dispatchOrdinal: 0,
      lifecycle: 'settled',
      toolMode: 'required',
      budgetClass: 'recovery',
      workspaceRevision: 3,
      settledWorkspaceRevision: 4,
      boundaryClass: 'tool_free_stop',
      usage: zeroWorkUsage,
    }],
    transitions: [{
      transitionId: 'transition-terminal',
      handoffId: 'handoff-terminal',
      transitionKind: 'terminal',
      sourceSegment: { segmentId: 'segment-built-in', phaseId: null, phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 1 },
      sourceWorkspaceRevision: 4,
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
      cause: 'tool_free_stop',
    }],
  },
}

const sourceDeletedWithoutAssociationInspection: AgentRunInspectionDetailV1 = {
  ...sourceDeletedInspection,
  reason: 'stale_input',
  workspaceAssociations: [],
  sectionAvailability: [{
    section: 'workspace',
    state: 'not_recorded',
    reason: 'stale_input',
  }],
}
const recoveredCancelledInspection: AgentRunInspectionDetailV1 = {
  ...sourceDeletedInspection,
  outcome: 'stopped',
  reason: 'user_stop',
  committedTarget: null,
  activity: {
    ...sourceDeletedInspection.activity,
    outcome: 'stopped',
    reason: 'user_stop',
    reconciliation: 'recovered',
  },
  error: {
    version: 1,
    inspectionAttemptId: attempt.attemptId,
    code: 'cancelled',
    category: 'cancelled',
    summaryCode: 'agentRun.errors.cancelled',
    causalCode: null,
    authority: 'host',
    source: 'execution',
    scope: 'attempt',
    capGate: {
      id: 'agent-capacity',
      limit: 1,
      observed: 2,
      exceeded: true,
      authority: 'host',
      source: 'execution',
    },
    target: {
      chatId: 'chat-deleted',
      generationType: 'normal',
      messageId: 'message-a',
      swipeId: 0,
    },
    workPhase: 'TERMINAL',
    workStatus: 'terminal',
    workOutcome: 'stopped',
    reason: 'user_stop',
    recoveryEligible: true,
    recoveryAction: 'retry',
    omissionCount: 0,
  },
  retry: {
    allowed: true,
    reason: 'user_stop',
    targetValid: true,
    linkedAttemptId: attempt.attemptId,
  },
}
const attachedWorkspaceRevision1: AgentPersistentWorkspaceV1 = {
  ...detachedWorkspace,
  id: 'workspace-live',
  chatId: 'chat-live',
  objective: 'Keep live work',
  metadata: {
    ...detachedWorkspace.metadata,
    title: 'Older workspace',
  },
  revision: 1,
  updatedAt: 1_100,
}
const attachedWorkspaceRevision2: AgentPersistentWorkspaceV1 = {
  ...attachedWorkspaceRevision1,
  metadata: {
    ...attachedWorkspaceRevision1.metadata,
    title: 'Newer workspace',
  },
  revision: 2,
  updatedAt: 1_200,
}
const attachedInspection: AgentRunInspectionDetailV1 = {
  ...sourceDeletedInspection,
  attempt: { ...attempt, target: { ...attempt.target, chatId: 'chat-live' } },
  activity: {
    ...sourceDeletedInspection.activity,
    attempt: { ...attempt, target: { ...attempt.target, chatId: 'chat-live' } },
  },
  workspaceAssociations: [{
    ...sourceDeletedInspection.workspaceAssociations[0]!,
    id: 'association-live',
    workspaceId: attachedWorkspaceRevision1.id,
    workspaceRevision: attachedWorkspaceRevision1.revision,
    sourceDeleted: false,
    correlation: { ...sourceDeletedInspection.workspaceAssociations[0]!.correlation, chatId: 'chat-live' },
  }],
  sectionAvailability: [{
    section: 'workspace',
    state: 'available',
    reason: null,
  }],
}

const boundedInspection: AgentRunInspectionDetailV1 = {
  ...sourceDeletedInspection,
  sectionAvailability: [...sourceDeletedInspection.sectionAvailability, {
    section: 'prompt',
    state: 'available',
    reason: null,
  }],
  transcript: Array.from({ length: 40 }, (_, index): AgentInspectionTranscriptRecordV1 => ({
    version: 1,
    id: `transcript-${index}`,
    kind: 'milestone',
    actor: 'host',
    recipient: null,
    correlation: { ...correlation, hostSequence: index + 1 },
    occurredAt: 1_000 + index,
    durationMs: null,
    late: false,
    content: `content-${index}`,
    arguments: null,
    result: null,
    provider: null,
    errorReason: null,
  })),
  turnSession: Array.from({ length: 40 }, (_, index): AgentTurnSessionEntryV1 => ({
    version: 1,
    id: `turn-session-${index}`,
    kind: 'recovery',
    correlation: { ...correlation, hostSequence: index + 1 },
    occurredAt: 1_000 + index,
    detail: `detail-${index}`,
    transcriptRecordIds: [`transcript-${index}`],
  })),
  promptEvidence: Array.from({ length: 40 }, (_, index): AgentPromptEvidenceV1 => {
    const sharedOccurrence = index < 2
    const collidingOccurrence = index === 2 || index === 3
    return {
      version: 1,
      id: `prompt-${index}`,
      sourceId: sharedOccurrence ? 'shared-source' : collidingOccurrence ? 'collision-source' : `source-${index}`,
      sourceRevision: 1,
      promptOrder: sharedOccurrence ? (index === 0 ? 3 : 7) : collidingOccurrence ? 0 : index,
      destination: 'root_work',
      role: index === 0 ? 'system' : index === 1 ? 'user' : index === 2 ? 'assistant' : index === 3 ? 'tool' : 'context',
      correlation: { ...correlation, hostSequence: index + 1 },
      included: true,
      content: `prompt-${index}`,
      contentDigest: `digest-${index}`,
      omissionReason: null,
      nativeProvenance: null,
      loomInspection: index === 0 ? {
        version: 1,
        surface: 'RESPONSE',
        checkpoint: 'ASSEMBLE',
        items: [],
        effectiveEntryIds: [],
        responseOmission: {
          version: 1,
          surface: 'RESPONSE',
          visibility: 'work_only',
          reason: 'work_only',
          omittedEntryIds: [],
          source: [],
          omittedPhaseInstructions: [
            { phaseId: 'phase-system', source: { kind: 'loom_block', blockId: 'shared-source', presetRevision: 1, blockRevision: 1, promptOrder: 3 } },
            { phaseId: 'phase-user', source: { kind: 'loom_block', blockId: 'shared-source', presetRevision: 1, blockRevision: 1, promptOrder: 7 } },
            { phaseId: 'phase-mismatched', source: { kind: 'loom_block', blockId: 'shared-source', presetRevision: 1, blockRevision: 1, promptOrder: 5 } },
            { phaseId: 'phase-collision', source: { kind: 'loom_block', blockId: 'collision-source', presetRevision: 1, blockRevision: 1, promptOrder: 0 } },
          ],
        },
      } : null,
    }
  }),
  markers: Array.from({ length: 40 }, (_, index): AgentInspectionMarkerV1 => ({
    version: 1,
    id: `marker-${index}`,
    kind: 'late_event',
    scope: 'transcript',
    correlation: { ...correlation, hostSequence: index + 1 },
    firstSequence: index + 1,
    lastSequence: index + 1,
    recoverable: true,
    detail: `marker-${index}`,
  })),
  usageEvidence: Array.from({ length: 40 }, (_, index): AgentInspectionUsageV1 => ({
    version: 1,
    id: `usage-${index}`,
    source: 'final',
    layer: 'root',
    correlation: { ...correlation, hostSequence: index + 1 },
    inputTokens: index + 1,
    outputTokens: 1,
    totalTokens: index + 2,
    toolCalls: 0,
    childInvocations: 0,
    canonical: true,
  })),
  usage: {
    ...sourceDeletedInspection.usage,
    layers: Array.from({ length: 40 }, (_, index): AgentInspectionUsageLayerV1 => ({
      version: 1,
      layer: index % 2 === 0 ? 'root' : 'child',
      source: 'final',
      correlation: { ...correlation, hostSequence: index + 1 },
      inputTokens: index + 1,
      outputTokens: 1,
      totalTokens: index + 2,
      toolCalls: 0,
      childInvocations: 0,
      evidenceIds: [`usage-${index}`],
      canonical: true,
    })),
  },
  cortexReceipts: Array.from({ length: 40 }, (_, index): AgentCortexReceiptV1 => ({
    version: 1,
    id: `cortex-${index}`,
    requestId: `request-${index}`,
    attemptId: attempt.attemptId,
    checkpoint: 'WORK',
    snapshotId: `snapshot-${index}`,
    sourceRevision: 1,
    revision: 1,
    scope: { chatId: 'chat-deleted', targetMessageId: 'message-a', targetSwipeId: 0 },
    required: false,
    startedAt: 1_000,
    completedAt: 1_001,
    state: 'accepted',
    resultDigest: null,
    resultCount: 0,
    correlation: { ...correlation, hostSequence: index + 1 },
    reason: null,
    omission: null,
    canonical: false,
  })),
  councilReceipts: Array.from({ length: 40 }, (_, index): AgentCouncilReceiptV1 => ({
    version: 1,
    id: `council-${index}`,
    requestId: `request-${index}`,
    checkpoint: 'WORK',
    required: false,
    startedAt: 1_000,
    completedAt: 1_001,
    state: 'accepted',
    memberCount: 1,
    resultDigest: null,
    correlation: { ...correlation, hostSequence: index + 1 },
    reason: null,
    canonical: false,
  })),
  workspaceAssociations: Array.from({ length: 40 }, (_, index): AgentWorkspaceAssociationV1 => ({
    version: 1,
    id: `association-${index}`,
    workspaceId: detachedWorkspace.id,
    workspaceRevision: detachedWorkspace.revision,
    relation: 'linked',
    objectKind: 'task',
    objectId: `task-${index}`,
    sourceRevision: null,
    sourceDeleted: true,
    provenanceDigest: null,
    correlation: { ...correlation, hostSequence: index + 1 },
  })),
}
const truncatedPromptInspection: AgentRunInspectionDetailV1 = {
  ...boundedInspection,
  promptEvidence: [{
    ...boundedInspection.promptEvidence[0]!,
    content: 'RETAINED COLLISION PREFIX',
    contentDigest: 'retained-collision-prefix',
  }],
  markers: [...boundedInspection.markers, {
    version: 1,
    id: 'prompt-truncated',
    kind: 'truncated',
    scope: 'prompt',
    correlation: { ...correlation, hostSequence: 41 },
    firstSequence: 2,
    lastSequence: 2,
    recoverable: false,
    detail: 'prompt records truncated: additional records omitted.',
  }],
  sectionAvailability: boundedInspection.sectionAvailability.map((entry) => entry.section === 'prompt'
    ? { ...entry, state: 'unavailable', reason: null }
    : entry),
}

test('uses stable deleted-chat provenance and localizes a recovered cancelled run', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousNode = globalThis.Node
  const previousEvent = globalThis.Event
  const previousKeyboardEvent = globalThis.KeyboardEvent
  const previousMouseEvent = globalThis.MouseEvent
  const previousGetComputedStyle = globalThis.getComputedStyle
  const previousNavigator = globalThis.navigator
  const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = runtime.IS_REACT_ACT_ENVIRONMENT
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const domWindow = dom.window as unknown as Window & typeof globalThis
  const previousClipboard = Object.getOwnPropertyDescriptor(domWindow.navigator, 'clipboard')?.value
  const previousMatchMedia = domWindow.matchMedia
  const matchMediaShim: Window['matchMedia'] = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList
  Object.assign(domWindow, { matchMedia: matchMediaShim })
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    KeyboardEvent: domWindow.KeyboardEvent,
    MouseEvent: domWindow.MouseEvent,
    getComputedStyle: domWindow.getComputedStyle,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: domWindow.navigator,
  })
  const writeText = mock((): Promise<void> => Promise.reject(new Error('clipboard unavailable')))
  Object.defineProperty(domWindow.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  runtime.IS_REACT_ACT_ENVIRONMENT = true

  const { agentRunsApi } = await import('@/api/agent-runs')
  const inspection = spyOn(agentRunsApi, 'inspection')
    .mockResolvedValueOnce(populatedWorkInspection)
    .mockResolvedValueOnce(sourceDeletedWithoutAssociationInspection)
    .mockResolvedValueOnce(recoveredCancelledInspection)
  const chatWorkspace = spyOn(agentRunsApi, 'persistentWorkspace').mockRejectedValue(new Error('chat route must not be used'))
  const workspaceById = spyOn(agentRunsApi, 'persistentWorkspaceById').mockResolvedValue(detachedWorkspace)
  const sessions = spyOn(agentRunsApi, 'persistentWorkspaceSessions').mockResolvedValue(detachedSessionPage)
  const tasks = spyOn(agentRunsApi, 'persistentWorkspaceTasks').mockResolvedValue([])
  const records = spyOn(agentRunsApi, 'persistentWorkspaceRecords').mockResolvedValue([])
  const submissions = spyOn(agentRunsApi, 'persistentWorkspaceSubmissions').mockResolvedValue([])
  const artifacts = spyOn(agentRunsApi, 'persistentWorkspaceArtifacts').mockResolvedValue([])
  const publications = spyOn(agentRunsApi, 'persistentWorkspacePublications').mockResolvedValue([])

  let root: Root | null = null
  let host: HTMLDivElement | null = null
  try {
    // ReactDOM captures browser globals at module evaluation; import after JSDOM setup.
    const { createRoot } = await import('react-dom/client')
    const { default: OwnerRunInspector } = await import('./OwnerRunInspector')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { chat } },
      interpolation: { escapeValue: false },
    })
    const container = document.createElement('div')
    host = container
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-deleted"
            isOpen
            onClose={() => {}}
            initialInspection={populatedWorkInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(inspection).toHaveBeenCalledWith(attempt.attemptId, 'chat-deleted')
    expect(workspaceById).toHaveBeenCalledWith(detachedWorkspace.id, null)
    expect(chatWorkspace).not.toHaveBeenCalled()
    const renderedText = document.body.textContent ?? ''
    expect(renderedText.split('Source chat deleted').length - 1).toBeGreaterThanOrEqual(2)
    const sessionRow = [...document.body.querySelectorAll('li')].find((item) => item.textContent?.includes('turn-detached'))
    expect(sessionRow).toBeDefined()
    expect(sessionRow?.textContent).toContain('Source chat deleted')
    expect(sessionRow?.textContent).toContain('turn-detached')
    expect(renderedText).toContain('Built-in WORK')
    expect(renderedText).toContain('Causal WORK timeline')
    expect(renderedText).toContain('handoff-terminal')
    expect(renderedText).toContain('dispatch-final')
    expect(document.querySelector('#owner-inspection-work-causal-timeline')).not.toBeNull()
    expect(document.querySelector('[aria-label="Causal WORK timeline: Terminal"]')).not.toBeNull()
    const recoveryCard = document.querySelector('[aria-label="Causal WORK timeline: Recovery"]')
    expect(recoveryCard?.textContent).toContain('dispatch-final')
    expect(recoveryCard?.textContent).not.toContain('dispatch-older-high-local-ordinal')
    const copyButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Copy correlation'))
    expect(copyButton).toBeDefined()
    await act(async () => {
      copyButton?.click()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain("Couldn’t copy the correlation ID.")
    const retryCopyButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Try again'))
    expect(retryCopyButton).toBeDefined()
    writeText.mockImplementation(() => Promise.resolve())
    await act(async () => {
      retryCopyButton?.click()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Copied')
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-deleted"
            isOpen
            onClose={() => {}}
            initialInspection={sourceDeletedWithoutAssociationInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(inspection).toHaveBeenCalledTimes(2)
    expect(workspaceById).toHaveBeenCalledTimes(1)
    expect(chatWorkspace).not.toHaveBeenCalled()
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-deleted"
            isOpen
            onClose={() => {}}
            initialInspection={recoveredCancelledInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(inspection).toHaveBeenCalledTimes(3)
    const errorText = document.body.textContent ?? ''
    const resolutionError = document.body.querySelector<HTMLElement>('[role="alert"]')
    const outcomeValue = [...(resolutionError?.querySelectorAll('dt') ?? [])]
      .find((label) => label.textContent === 'Outcome')
      ?.nextElementSibling?.textContent
    expect(errorText).toContain('Run resolution error')
    expect(errorText).toContain('Error code: cancelled')
    expect(errorText).toContain('The run was cancelled.')
    expect(resolutionError?.querySelector('p')?.textContent).toBe('Error code: cancelled · Cancelled · The run was cancelled.')
    expect(outcomeValue).toBe('Stopped')
    expect(errorText).toContain('User stop')
    expect(errorText).toContain('Authority')
    expect(errorText).toContain('Source')
    expect(errorText).toContain('Applies to')
    expect(errorText).toContain('Availability')
    expect(errorText).toContain('Not ready')
    expect(errorText).not.toContain('resolutionError.title')
    expect(errorText).not.toContain('agentRun.errors.cancelled')
    expect(errorText).not.toContain('provenance.authority')
    expect(errorText).not.toContain('provenance.source')
    expect(errorText).not.toContain('provenance.scope')
    expect(errorText).not.toContain('provenance.gate')
    expect(errorText).not.toContain('provenance.capabilityNotReady')
    expect(resolutionError).toBeDefined()
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    host?.remove()
    inspection.mockRestore()
    chatWorkspace.mockRestore()
    workspaceById.mockRestore()
    sessions.mockRestore()
    tasks.mockRestore()
    records.mockRestore()
    submissions.mockRestore()
    artifacts.mockRestore()
    publications.mockRestore()
    Object.defineProperty(domWindow.navigator, 'clipboard', {
      configurable: true,
      value: previousClipboard,
    })
    if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia
    else delete domWindow.matchMedia
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Element: previousElement,
      HTMLElement: previousHTMLElement,
      Node: previousNode,
      Event: previousEvent,
      KeyboardEvent: previousKeyboardEvent,
      MouseEvent: previousMouseEvent,
      getComputedStyle: previousGetComputedStyle,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previousNavigator,
    })
    if (previousActEnvironment === undefined) delete runtime.IS_REACT_ACT_ENVIRONMENT
    else runtime.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
test('keeps the accepted store revision when an older workspace response overlaps it', async () => {
  const { agentRunsApi } = await import('@/api/agent-runs')
  const { useStore } = await import('@/store')
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousNode = globalThis.Node
  const previousEvent = globalThis.Event
  const previousKeyboardEvent = globalThis.KeyboardEvent
  const previousMouseEvent = globalThis.MouseEvent
  const previousGetComputedStyle = globalThis.getComputedStyle
  const previousNavigator = globalThis.navigator
  const previousWorkspaceByChat = useStore.getState().agentPersistentWorkspaceByChat
  const previousWorkspaceById = useStore.getState().agentPersistentWorkspaceById
  const previousWorkspaceEpochs = useStore.getState().agentPersistentWorkspaceRequestEpochByKey
  const previousWorkspaceCollections = useStore.getState().agentPersistentWorkspaceCollectionsById
  const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = runtime.IS_REACT_ACT_ENVIRONMENT
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const domWindow = dom.window as unknown as Window & typeof globalThis
  const previousMatchMedia = domWindow.matchMedia
  const matchMediaShim: Window['matchMedia'] = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList
  Object.assign(domWindow, { matchMedia: matchMediaShim })
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    KeyboardEvent: domWindow.KeyboardEvent,
    MouseEvent: domWindow.MouseEvent,
    getComputedStyle: domWindow.getComputedStyle,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: domWindow.navigator,
  })
  runtime.IS_REACT_ACT_ENVIRONMENT = true

  let firstWorkspaceRequest = true
  let resolveFirstWorkspace: ((workspace: AgentPersistentWorkspaceV1) => void) | null = null
  const inspection = spyOn(agentRunsApi, 'inspection').mockResolvedValue(attachedInspection)
  const workspaceById = spyOn(agentRunsApi, 'persistentWorkspaceById').mockImplementation(async () => {
    if (firstWorkspaceRequest) {
      firstWorkspaceRequest = false
      return new Promise<AgentPersistentWorkspaceV1>((resolve) => {
        resolveFirstWorkspace = resolve
      })
    }
    return attachedWorkspaceRevision2
  })
  const chatWorkspace = spyOn(agentRunsApi, 'persistentWorkspace').mockRejectedValue(new Error('chat route must not be used'))
  const sessions = spyOn(agentRunsApi, 'persistentWorkspaceSessions').mockResolvedValue(detachedSessionPage)
  const tasks = spyOn(agentRunsApi, 'persistentWorkspaceTasks').mockResolvedValue([])
  const records = spyOn(agentRunsApi, 'persistentWorkspaceRecords').mockResolvedValue([])
  const submissions = spyOn(agentRunsApi, 'persistentWorkspaceSubmissions').mockResolvedValue([])
  const artifacts = spyOn(agentRunsApi, 'persistentWorkspaceArtifacts').mockResolvedValue([])
  const publications = spyOn(agentRunsApi, 'persistentWorkspacePublications').mockResolvedValue([])
  const editWorkspace = spyOn(agentRunsApi, 'editPersistentWorkspace').mockResolvedValue(attachedWorkspaceRevision2)

  let root: Root | null = null
  let host: HTMLDivElement | null = null
  try {
    useStore.setState({
      agentPersistentWorkspaceByChat: {},
      agentPersistentWorkspaceById: {},
      agentPersistentWorkspaceRequestEpochByKey: {},
      agentPersistentWorkspaceCollectionsById: {},
    })
    const { createRoot } = await import('react-dom/client')
    const { default: OwnerRunInspector } = await import('./OwnerRunInspector')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { chat } },
      interpolation: { escapeValue: false },
    })
    const container = document.createElement('div')
    host = container
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-live"
            isOpen
            onClose={() => {}}
            initialInspection={attachedInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(workspaceById).toHaveBeenCalledWith(attachedWorkspaceRevision1.id, 'chat-live')
    expect(resolveFirstWorkspace).not.toBeNull()
    useStore.setState((state) => ({
      agentPersistentWorkspaceById: {
        ...state.agentPersistentWorkspaceById,
        [attachedWorkspaceRevision2.id]: {
          status: 'ready',
          availability: 'attached',
          workspace: attachedWorkspaceRevision2,
          error: null,
          requestEpoch: state.agentPersistentWorkspaceRequestEpochByKey[`id:${attachedWorkspaceRevision2.id}`] ?? 0,
        },
      },
    }))
    await act(async () => {
      resolveFirstWorkspace?.(attachedWorkspaceRevision1)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    const renderedText = document.body.textContent ?? ''
    expect(renderedText).toContain('Newer workspace')
    expect(renderedText).not.toContain('Older workspace')
    expect(renderedText).toContain('Revision 2')
    const titleInput = [...document.body.querySelectorAll('input')].find((input) => input.value === attachedWorkspaceRevision2.metadata.title)
    expect(titleInput).toBeDefined()
    const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      if (titleInput) {
        titleInput.focus()
        valueSetter.call(titleInput, 'Edited newer workspace')
        titleInput.dispatchEvent(new domWindow.Event('input', { bubbles: true, cancelable: true }))
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    const saveButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Save changes'))
    expect(saveButton).toBeDefined()
    await act(async () => {
      saveButton?.click()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(editWorkspace).toHaveBeenCalledWith(attachedWorkspaceRevision2.id, expect.objectContaining({ expectedRevision: 2 }))
    expect(chatWorkspace).not.toHaveBeenCalled()
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    host?.remove()
    inspection.mockRestore()
    workspaceById.mockRestore()
    chatWorkspace.mockRestore()
    sessions.mockRestore()
    tasks.mockRestore()
    records.mockRestore()
    submissions.mockRestore()
    artifacts.mockRestore()
    publications.mockRestore()
    editWorkspace.mockRestore()
    useStore.setState({
      agentPersistentWorkspaceByChat: previousWorkspaceByChat,
      agentPersistentWorkspaceById: previousWorkspaceById,
      agentPersistentWorkspaceRequestEpochByKey: previousWorkspaceEpochs,
      agentPersistentWorkspaceCollectionsById: previousWorkspaceCollections,
    })
    if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia
    else delete domWindow.matchMedia
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Element: previousElement,
      HTMLElement: previousHTMLElement,
      Node: previousNode,
      Event: previousEvent,
      KeyboardEvent: previousKeyboardEvent,
      MouseEvent: previousMouseEvent,
      getComputedStyle: previousGetComputedStyle,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previousNavigator,
    })
    if (previousActEnvironment === undefined) delete runtime.IS_REACT_ACT_ENVIRONMENT
    else runtime.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
test('bounds owner inspection collections and withholds Loom roles from incomplete prompt evidence', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousNode = globalThis.Node
  const previousEvent = globalThis.Event
  const previousKeyboardEvent = globalThis.KeyboardEvent
  const previousMouseEvent = globalThis.MouseEvent
  const previousGetComputedStyle = globalThis.getComputedStyle
  const previousNavigator = globalThis.navigator
  const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = runtime.IS_REACT_ACT_ENVIRONMENT
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const domWindow = dom.window as unknown as Window & typeof globalThis
  const previousMatchMedia = domWindow.matchMedia
  const matchMediaShim: Window['matchMedia'] = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList
  Object.assign(domWindow, { matchMedia: matchMediaShim })
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    KeyboardEvent: domWindow.KeyboardEvent,
    MouseEvent: domWindow.MouseEvent,
    getComputedStyle: domWindow.getComputedStyle,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: domWindow.navigator,
  })
  runtime.IS_REACT_ACT_ENVIRONMENT = true

  const { agentRunsApi } = await import('@/api/agent-runs')
  const inspection = spyOn(agentRunsApi, 'inspection').mockResolvedValue(boundedInspection)
  const workspaceById = spyOn(agentRunsApi, 'persistentWorkspaceById').mockResolvedValue(detachedWorkspace)
  const sessions = spyOn(agentRunsApi, 'persistentWorkspaceSessions').mockResolvedValue(boundedWorkspaceSessions)
  const tasks = spyOn(agentRunsApi, 'persistentWorkspaceTasks').mockResolvedValue([])
  const records = spyOn(agentRunsApi, 'persistentWorkspaceRecords').mockResolvedValue([])
  const submissions = spyOn(agentRunsApi, 'persistentWorkspaceSubmissions').mockResolvedValue([])
  const artifacts = spyOn(agentRunsApi, 'persistentWorkspaceArtifacts').mockResolvedValue([])
  const publications = spyOn(agentRunsApi, 'persistentWorkspacePublications').mockResolvedValue([])

  let root: Root | null = null
  let host: HTMLDivElement | null = null
  try {
    const { createRoot } = await import('react-dom/client')
    const { default: OwnerRunInspector } = await import('./OwnerRunInspector')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { chat } },
      interpolation: { escapeValue: false },
    })
    const container = document.createElement('div')
    host = container
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-deleted"
            isOpen
            onClose={() => {}}
            initialInspection={boundedInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(document.querySelectorAll('#owner-inspection-timeline > button')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-turn-session-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-prompts-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-markers-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-usage-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-usage-layers-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#owner-inspection-workspace-associations-list > article')).toHaveLength(12)
    expect(document.querySelectorAll('#persistent-workspace-sessions li')).toHaveLength(12)
    expect(document.body.textContent).toContain('Cortex: 12 / 40')
    expect(document.body.textContent).toContain('Council: 12 / 40')
    const phaseArticle = (phaseId: string) => [...document.querySelectorAll('article')]
      .find((article) => article.querySelector('header strong')?.textContent === phaseId)
    expect(phaseArticle('phase-system')?.textContent).toContain('System')
    expect(phaseArticle('phase-user')?.textContent).toContain('User')
    expect(phaseArticle('phase-mismatched')?.textContent).toContain('Not recorded')
    expect(phaseArticle('phase-collision')?.textContent).toContain('Not recorded')

    inspection.mockResolvedValue(truncatedPromptInspection)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <OwnerRunInspector
            attemptId={attempt.attemptId}
            chatId="chat-deleted"
            isOpen
            onClose={() => {}}
            initialInspection={truncatedPromptInspection}
          />
        </I18nextProvider>,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(phaseArticle('phase-system')?.textContent).toContain('Not recorded')

    const showMoreTurnSession = document.querySelector<HTMLButtonElement>('button[aria-controls="owner-inspection-turn-session-list"]')
    expect(showMoreTurnSession).toBeDefined()
    await act(async () => {
      showMoreTurnSession?.click()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelectorAll('#owner-inspection-turn-session-list > article')).toHaveLength(36)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    host?.remove()
    inspection.mockRestore()
    workspaceById.mockRestore()
    sessions.mockRestore()
    tasks.mockRestore()
    records.mockRestore()
    submissions.mockRestore()
    artifacts.mockRestore()
    publications.mockRestore()
    if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia
    else delete domWindow.matchMedia
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Element: previousElement,
      HTMLElement: previousHTMLElement,
      Node: previousNode,
      Event: previousEvent,
      KeyboardEvent: previousKeyboardEvent,
      MouseEvent: previousMouseEvent,
      getComputedStyle: previousGetComputedStyle,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previousNavigator,
    })
    if (previousActEnvironment === undefined) delete runtime.IS_REACT_ACT_ENVIRONMENT
    else runtime.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
