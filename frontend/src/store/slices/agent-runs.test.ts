import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import {
  agentRunProvisionalKey,
  agentRunTerminalTargetKey,
  createAgentRunsSlice,
  normalizeAgentRunChangesV2,
  normalizeAgentRunPublicV2,
  selectActiveAgentRunForChat,
  selectAgentRunForTarget,
  settleGenerationRequestFromExactTerminalRun,
} from './agent-runs'
import type { AgentRunChangesV2, AgentRunPublicV2 } from '@/types/agent-runs'

type TestStore = Pick<AppStore, 'activeChatId' | 'generationRequests' | 'settleGenerationRequest'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  generationRequests: {},
  settleGenerationRequest: (chatId, status, generationId, requestAuthorityId) => {
    let settled = false
    set((state) => {
      const current = state.generationRequests[chatId]
      if (
        !current
        || generationId === null
        || current.generationId !== generationId
        || current.requestAuthorityId !== requestAuthorityId
      ) return state
      settled = true
      return {
        generationRequests: {
          ...state.generationRequests,
          [chatId]: {
            ...current,
            status,
            abortController: null,
            terminalGenerationIds: current.terminalGenerationIds.includes(generationId)
              ? current.terminalGenerationIds
              : [...current.terminalGenerationIds, generationId],
          },
        },
      }
    })
    return settled
  },
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))

function run(overrides: Partial<AgentRunPublicV2> = {}): AgentRunPublicV2 {
  return {
    version: 2,
    runId: 'run-a',
    turnId: 'turn-a',
    generationId: 'generation-a',
    chatId: 'chat-a',
    generationType: 'normal',
    target: null,
    workPhase: 'WORK',
    workStatus: 'running',
    workOutcome: null,
    recoveryEligible: false,
    recoveryAction: 'none',
    omissionCount: 0,
    inspectionAttemptId: 'attempt-a',
    reason: null,
    attemptLineage: {
      version: 1,
      attemptId: 'attempt-a',
      previousAttemptId: null,
      target: {
        chatId: 'chat-a',
        generationType: 'normal',
        messageId: null,
        swipeId: null,
      },
      createdAt: 1_000,
    },
    revision: 1,
    sequence: 1,
    startedAt: 1_000,
    updatedAt: 2_000,
    activity: [{
      version: 2,
      id: 'root',
      parentId: null,
      kind: 'root',
      actor: 'root',
      phase: 'WORK',
      status: 'running',
      startedAt: 1_000,
      elapsedMs: 1_000,
    }],
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, toolCalls: 0, childInvocations: 0 },
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    ...overrides,
  }
}

function changes(
  runs: AgentRunPublicV2[],
  overrides: Partial<Pick<AgentRunChangesV2,
    | 'cursor'
    | 'cursorSequence'
    | 'lastSequence'
    | 'tailSequence'
    | 'hasMore'
    | 'resync'
    | 'resyncPage'
  >> = {},
): AgentRunChangesV2 {
  const sequence = runs.reduce((max, item) => Math.max(max, item.sequence), 0)
  const lastSequence = overrides.lastSequence ?? sequence
  const cursorSequence = overrides.cursorSequence ?? lastSequence
  const tailSequence = overrides.tailSequence ?? Math.max(sequence, lastSequence)
  return {
    version: 2,
    chatId: 'chat-a',
    cursor: overrides.cursor ?? { version: 1, token: 'opaque-cursor-a' },
    cursorSequence,
    lastSequence,
    tailSequence,
    hasMore: overrides.hasMore ?? false,
    resync: overrides.resync ?? false,
    ...(overrides.resyncPage ? { resyncPage: overrides.resyncPage } : {}),
    runs,
    events: [],
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
  }
}

beforeEach(() => {
  useStore.setState({
    activeChatId: 'chat-a',
    generationRequests: {},
    agentRunProvisionalByKey: {},
    agentRunTerminalByTarget: {},
    agentRunCursorByChat: {},
    agentRunLastSequenceByChat: {},
    agentRunCursorSequenceByChat: {},
    agentRunResyncOffsetByChat: {},
    agentRunResyncDescriptorByChat: {},
    agentRunOmittedEventsByChat: {},
    agentRunRequestEpochByChat: {},
    agentWorkspaceByTurn: {},
    agentWorkspaceRequestEpochByKey: {},
  })
})


describe('agent run projection slice', () => {
  test('an exact rejected terminal run retires the queued request authority', () => {
    useStore.setState({
      generationRequests: {
        'chat-a': {
          chatId: 'chat-a',
          epoch: 1,
          requestAuthorityId: 'request-a',
          generationId: 'generation-a',
          abortController: new AbortController(),
          status: 'queued',
          generationType: 'normal',
          targetMessageId: null,
          targetSwipeId: null,
          retiredGenerationIds: [],
          terminalGenerationIds: [],
        },
      },
    })

    expect(useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 1,
      run: run({
        revision: 2,
        sequence: 1,
        workPhase: 'TERMINAL',
        workStatus: 'terminal',
        workOutcome: 'rejected',
        reason: 'needs_attention',
      }),
      omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    })).toBe('applied')

    const request = useStore.getState().generationRequests['chat-a']
    expect(request.status).toBe('error')
    expect(request.abortController).toBeNull()
    expect(request.terminalGenerationIds).toEqual(['generation-a'])
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a', 'generation-a')).toBeUndefined()
  })
  test('settles a terminal Agent Run that arrived before the exact start response bound its request', () => {
    useStore.setState({
      generationRequests: {
        'chat-a': {
          chatId: 'chat-a',
          epoch: 1,
          requestAuthorityId: 'request-a',
          generationId: null,
          abortController: new AbortController(),
          status: 'pending',
          generationType: 'normal',
          targetMessageId: null,
          targetSwipeId: null,
          retiredGenerationIds: [],
          terminalGenerationIds: [],
        },
      },
    })
    expect(useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 1,
      run: run({
        revision: 2,
        sequence: 1,
        workPhase: 'TERMINAL',
        workStatus: 'terminal',
        workOutcome: 'rejected',
        reason: 'needs_attention',
      }),
      omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    })).toBe('applied')
    expect(useStore.getState().generationRequests['chat-a'].status).toBe('pending')

    useStore.setState((state) => ({
      generationRequests: {
        ...state.generationRequests,
        'chat-a': {
          ...state.generationRequests['chat-a'],
          generationId: 'generation-a',
          status: 'queued',
        },
      },
    }))
    expect(settleGenerationRequestFromExactTerminalRun(
      useStore.getState(),
      'chat-a',
      'generation-a',
    )).toBe(true)
    expect(useStore.getState().generationRequests['chat-a']).toMatchObject({
      requestAuthorityId: 'request-a',
      generationId: 'generation-a',
      status: 'error',
      terminalGenerationIds: ['generation-a'],
    })

    useStore.setState((state) => ({
      generationRequests: {
        ...state.generationRequests,
        'chat-a': {
          ...state.generationRequests['chat-a'],
          requestAuthorityId: 'request-b',
          generationId: 'generation-b',
          status: 'queued',
          abortController: new AbortController(),
          terminalGenerationIds: [],
        },
      },
    }))
    expect(settleGenerationRequestFromExactTerminalRun(
      useStore.getState(),
      'chat-a',
      'generation-a',
    )).toBe(false)
    expect(useStore.getState().generationRequests['chat-a']).toMatchObject({
      requestAuthorityId: 'request-b',
      generationId: 'generation-b',
      status: 'queued',
      terminalGenerationIds: [],
    })
  })
  test('rejects public runs whose attempt lineage does not bind to the run identity', () => {
    expect(normalizeAgentRunPublicV2(run({
      inspectionAttemptId: 'attempt-other',
      attemptLineage: { ...run().attemptLineage, attemptId: 'attempt-a' },
    }))).toBeNull()
    expect(normalizeAgentRunPublicV2(run({
      attemptLineage: {
        ...run().attemptLineage,
        target: { ...run().attemptLineage.target, chatId: 'chat-b' },
      },
    }))).toBeNull()
    expect(normalizeAgentRunPublicV2(run({
      target: { messageId: 'message-a', swipeId: 0 },
      attemptLineage: {
        ...run().attemptLineage,
        target: { ...run().attemptLineage.target, messageId: 'message-b', swipeId: 0 },
      },
    }))).toBeNull()
  })
  test('accepts only increasing run revisions and advances one opaque cursor per chat', () => {
    const state = useStore.getState()
    const firstEpoch = state.beginAgentRunRestore('chat-a')
    expect(state.applyAgentRunChanges('chat-a', firstEpoch, changes([run()]))) .toBe(true)

    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([
      run({ revision: 1, sequence: 2, workPhase: 'ASSEMBLE' }),
      run({ revision: 2, sequence: 3, workPhase: 'RENDER', updatedAt: 3_000 }),
    ], { cursor: { version: 1, token: 'opaque-cursor-b' }, lastSequence: 3 }))

    const stored = useStore.getState().agentRunProvisionalByKey[agentRunProvisionalKey(run({ revision: 2 }))]
    expect(stored.workPhase).toBe('RENDER')
    expect(stored.revision).toBe(2)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('opaque-cursor-b')
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(3)
  })
  test('keeps the consumed cursor separate from a live event watermark during recovery', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 2,
      run: run({ revision: 2, sequence: 2, workPhase: 'RENDER', updatedAt: 3_000 }),
      omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    })).toBe('gap')

    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([
      run({ sequence: 1, updatedAt: 2_000 }),
    ], {
      cursor: { version: 1, token: 'cursor-consumed-1' },
      cursorSequence: 1,
      lastSequence: 1,
    }))).toBe(true)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('cursor-consumed-1')
    expect(useStore.getState().agentRunCursorSequenceByChat['chat-a']).toBe(1)
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')

    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([
      run({ revision: 2, sequence: 2, workPhase: 'RENDER', updatedAt: 3_000 }),
    ], {
      cursor: { version: 1, token: 'cursor-consumed-2' },
      cursorSequence: 2,
      lastSequence: 2,
    }))).toBe(true)
    expect(useStore.getState().agentRunCursorSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
  })

  test('keeps an oversized full resync stale until every bounded page is applied', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    const firstPage = Array.from({ length: 16 }, (_, index) => run({
      runId: `run-${index}`,
      turnId: `turn-${index}`,
      generationId: `generation-${index}`,
      inspectionAttemptId: `attempt-${index}`,
      attemptLineage: { ...run().attemptLineage, attemptId: `attempt-${index}` },
      sequence: index + 1,
    }))
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes(firstPage, {
      resync: true,
      hasMore: true,
      cursor: { version: 1, token: 'resync-page-1' },
      cursorSequence: 20,
      lastSequence: 20,
      resyncPage: {
        offset: 0,
        returnedRuns: 16,
        totalRuns: 17,
        snapshotSequence: 20,
        complete: false,
        omittedRuns: 1,
        omittedOlderRuns: 0,
      },
    }))).toBe(true)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(16)

    const finalRun = run({
      runId: 'run-16',
      turnId: 'turn-16',
      generationId: 'generation-16',
      sequence: 17,
    })
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([finalRun], {
      resync: true,
      cursor: { version: 1, token: 'resync-page-2' },
      cursorSequence: 20,
      lastSequence: 20,
      resyncPage: {
        offset: 16,
        returnedRuns: 1,
        totalRuns: 17,
        snapshotSequence: 20,
        complete: true,
        omittedRuns: 0,
        omittedOlderRuns: 0,
      },
    }))).toBe(true)
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(17)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
  })

  test('rejects skipped, replayed, and malformed resync pages without losing accepted rows', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    const firstPage = Array.from({ length: 16 }, (_, index) => run({
      runId: `run-${index}`,
      turnId: `turn-${index}`,
      generationId: `generation-${index}`,
      inspectionAttemptId: `attempt-${index}`,
      attemptLineage: { ...run().attemptLineage, attemptId: `attempt-${index}` },
      sequence: index + 1,
    }))
    const firstPayload = changes(firstPage, {
      resync: true,
      hasMore: true,
      cursorSequence: 2,
      lastSequence: 2,
      tailSequence: 2,
      resyncPage: { offset: 0, returnedRuns: 16, totalRuns: 18, snapshotSequence: 2, complete: false, omittedRuns: 2, omittedOlderRuns: 0 },
    })
    const firstResyncPage = firstPayload.resyncPage
    if (!firstResyncPage) throw new Error('full resync fixture is missing its page descriptor')
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, firstPayload)).toBe(true)
    const accepted = selectActiveAgentRunForChat(useStore.getState(), 'chat-a')
    const acceptedCursor = useStore.getState().agentRunCursorByChat['chat-a']

    const skippedPage = changes([run({
      runId: 'run-skipped',
      turnId: 'turn-skipped',
      generationId: 'generation-skipped',
      inspectionAttemptId: 'attempt-skipped',
      attemptLineage: { ...run().attemptLineage, attemptId: 'attempt-skipped' },
      sequence: 17,
    })], {
      resync: true,
      cursorSequence: 2,
      lastSequence: 2,
      tailSequence: 2,
      resyncPage: { offset: 17, returnedRuns: 1, totalRuns: 18, snapshotSequence: 2, complete: true, omittedRuns: 0, omittedOlderRuns: 0 },
    })
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, firstPayload)).toBe(false)
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, skippedPage)).toBe(false)
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a')).toEqual(accepted)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe(acceptedCursor)

    expect(normalizeAgentRunChangesV2({
      ...firstPayload,
      resyncPage: { ...firstResyncPage, returnedRuns: 2 },
    })).toBeNull()
    expect(normalizeAgentRunChangesV2({
      ...firstPayload,
      resyncPage: { ...firstResyncPage, returnedRuns: 17, totalRuns: 17, omittedRuns: 0, omittedOlderRuns: 0, complete: true },
      hasMore: false,
    })).toBeNull()
    expect(normalizeAgentRunChangesV2({
      ...firstPayload,
      resyncPage: { ...firstResyncPage, complete: true },
    })).toBeNull()
    expect(normalizeAgentRunChangesV2({
      ...firstPayload,
      hasMore: false,
    })).toBeNull()
  })


  test('freezes the last tree on reconnect, reports sequence gaps, and replaces it on full resync', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([run()]))
    useStore.getState().markAgentRunsStale('chat-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(1)

    const gapResult = useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 4,
      run: run({ revision: 2, sequence: 4, workPhase: 'RENDER', updatedAt: 4_000 }),
      omission: { omittedNodeCount: 0, omittedEventCount: 1, firstOmittedSequence: 2, lastOmittedSequence: 3 },
    })
    expect(gapResult).toBe('gap')
    expect(useStore.getState().agentRunOmittedEventsByChat['chat-a']).toBeGreaterThanOrEqual(3)

    const restoreEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, changes([
      run({ revision: 3, sequence: 5, workPhase: 'TERMINAL', workStatus: 'terminal', workOutcome: 'completed' }),
    ], {
      resync: true,
      lastSequence: 5,
      cursor: { version: 1, token: 'fresh-cursor' },
      resyncPage: { offset: 0, returnedRuns: 1, totalRuns: 1, snapshotSequence: 5, complete: true, omittedRuns: 0, omittedOlderRuns: 0 },
    }))
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('fresh-cursor')
  })

  test('moves a provisional run only to its authoritative message and swipe handoff', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([run()]))
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(1)

    const terminal = run({
      revision: 2,
      sequence: 2,
      workPhase: 'TERMINAL',
      workStatus: 'terminal',
      workOutcome: 'completed',
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-a',
        swipeId: 2,
        messageRevision: 8,
        swipeRevision: 3,
      },
    })
    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([terminal]))

    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(0)
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-a', 2)
    ]?.turnId).toBe('turn-a')
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-a', 1)
    ]).toBeUndefined()
  })

  test('rejects stale request epochs and cross-chat responses', () => {
    const staleEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', staleEpoch, changes([run()]))).toBe(false)

    const currentEpoch = useStore.getState().agentRunRequestEpochByChat['chat-a']
    useStore.setState({ activeChatId: 'chat-b' })
    expect(useStore.getState().applyAgentRunChanges('chat-a', currentEpoch, changes([run()]))).toBe(false)
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(0)
  })

  test('terminalizes malformed restore snapshots without deleting an accepted run', () => {
    const firstEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', firstEpoch, changes([run()]))).toBe(true)

    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, {
      version: 2,
      chatId: 'chat-a',
    })).toBe(false)

    const state = useStore.getState()
    expect(state.agentRunSyncByChat['chat-a']).toBe('error')
    expect(selectActiveAgentRunForChat(state, 'chat-a')).toMatchObject({ runId: 'run-a', turnId: 'turn-a' })
  })
  test('normalizes a closed projection and drops private or generic payload fields', () => {
    const normalized = normalizeAgentRunPublicV2({
      ...run(),
      prompt: 'PRIVATE PROMPT',
      reasoning: 'PRIVATE REASONING',
      credentials: 'SECRET',
      metadata: { arguments: 'PRIVATE ARGUMENTS', result: 'PRIVATE RESULT' },
      activity: [{
        ...run().activity[0],
        prose: 'PRIVATE CHILD PROSE',
        arguments: { secret: true },
        result: 'PRIVATE TOOL RESULT',
      }],
    })
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('metadata')
    expect(serialized).not.toContain('arguments')
    expect(serialized).not.toContain('result')
  })
  test('projects unknown provider tools through the safe public catalog', () => {
    const unknown = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], toolId: 'future_provider_tool' }],
    })
    expect(unknown?.activity[0]?.toolId).toBe('unknown_tool')

    const explicit = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], toolId: 'unknown_tool' }],
    })
    expect(explicit?.activity[0]?.toolId).toBe('unknown_tool')
  })

  test('keeps approved activity error codes and does not vanish unknown codes', () => {
    const approved = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], errorCode: 'child_required_failed' }],
    })
    expect(approved?.activity[0]?.errorCode).toBe('child_required_failed')

    const outputLimit = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], errorCode: 'child_output_limit_exceeded' }],
    })
    expect(outputLimit?.activity[0]?.errorCode).toBe('child_output_limit_exceeded')

    const protocol = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], errorCode: 'agentic_protocol_failure' }],
    })
    expect(protocol?.activity[0]?.errorCode).toBe('agentic_protocol_failure')

    const unknown = normalizeAgentRunPublicV2({
      ...run(),
      activity: [{ ...run().activity[0], errorCode: 'secret_internal_code' }],
    })
    expect(unknown).not.toBeNull()
    expect(unknown?.activity[0]?.errorCode).toBeUndefined()
  })

  test('collapses unknown owner-run error taxonomy to canonical internal_error', () => {
    const error = {
      code: 'secret_internal_code',
      category: 'integrity',
      summaryCode: 'attacker_taxonomy',
      recoveryEligible: false,
      recoveryAction: 'none',
      target: null,
      workPhase: 'WORK',
      workStatus: 'terminal',
      workOutcome: 'failed',
      reason: null,
      omissionCount: 0,
      inspectionAttemptId: 'attempt-a',
    }
    const unknown = normalizeAgentRunPublicV2({ ...run(), error })
    expect(unknown).not.toBeNull()
    expect(unknown?.error).toMatchObject({
      code: 'internal_error',
      category: 'internal',
      summaryCode: 'internal_error',
    })

    const approved = normalizeAgentRunPublicV2({
      ...run(),
      error: { ...error, code: 'child_required_failed', summaryCode: 'child_required_failed' },
    })
    expect(approved?.error).toMatchObject({
      code: 'child_required_failed',
      category: 'integrity',
      summaryCode: 'child_required_failed',
    })
  })


  test('fetches workspace state separately and rejects an older workspace revision', () => {
    const indexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', indexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)

    const sectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', sectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: [{
        kind: 'task',
        id: 'task-a',
        revision: 2,
        retention: 'turn_terminal',
        visibility: 'owner',
        title: 'Check continuity',
        state: 'active',
        required: true,
        assigned: false,
        dependencyCount: 0,
        privateBody: 'PRIVATE WORK',
      }],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)
    expect(JSON.stringify(useStore.getState().agentWorkspaceByTurn['turn-a'])).not.toContain('PRIVATE WORK')

    const staleEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', staleEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 3,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.preview.workspaceRevision).toBe(4)

    const crossChatEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    useStore.setState({ activeChatId: 'chat-b' })
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', crossChatEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 5,
      sections: [],
      omitted: 0,
    })).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].status).toBe('idle')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].index?.workspaceRevision).toBe(4)
  })
  test('terminalizes malformed workspace snapshots without dropping newer accepted state', () => {
    const indexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', indexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    const sectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', sectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)

    const invalidIndexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', invalidIndexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 5,
      sections: 'invalid',
      omitted: 0,
    })).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a']).toMatchObject({
      status: 'error',
      error: true,
      index: { workspaceRevision: 4 },
    })

    const retryIndexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', retryIndexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    const invalidSectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', invalidSectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: 'invalid',
      nextPage: null,
      omitted: 0,
    }, false)).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks).toMatchObject({
      loadingMore: false,
      error: true,
      preview: { workspaceRevision: 4, entries: [] },
    })
  })
  test('rejects an older different-turn terminal from replacing a newer target projection', () => {
    const newer = run({
      runId: 'run-new',
      turnId: 'turn-new',
      generationId: 'generation-new',
      workStatus: 'terminal',
      workPhase: 'TERMINAL',
      workOutcome: 'completed',
      revision: 2,
      sequence: 20,
      updatedAt: 20_000,
      target: { messageId: 'message-target', swipeId: 1 },
      attemptLineage: {
        ...run().attemptLineage,
        target: { chatId: 'chat-a', generationType: 'normal', messageId: 'message-target', swipeId: 1 },
      },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-target',
        swipeId: 1,
        messageRevision: 8,
        swipeRevision: 4,
      },
    })
    const stale = run({
      runId: 'run-old',
      turnId: 'turn-old',
      generationId: 'generation-old',
      workStatus: 'terminal',
      workPhase: 'TERMINAL',
      workOutcome: 'completed',
      revision: 99,
      sequence: 19,
      updatedAt: 99_000,
      target: { messageId: 'message-target', swipeId: 1 },
      attemptLineage: {
        ...run().attemptLineage,
        target: { chatId: 'chat-a', generationType: 'normal', messageId: 'message-target', swipeId: 1 },
      },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-target',
        swipeId: 1,
        messageRevision: 7,
        swipeRevision: 9,
      },
    })
    const firstEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', firstEpoch, changes([newer]))).toBe(true)
    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([stale]))).toBe(true)
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-target', 1)
    ]?.turnId).toBe('turn-new')
  })

  test('keeps the opaque cursor and newer projections during a delayed lower-sequence resync', () => {
    const firstEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', firstEpoch, changes([
      run({ sequence: 10, revision: 4, updatedAt: 10_000 }),
    ], {
      lastSequence: 10,
      cursor: { version: 1, token: 'cursor-new' },
    }))).toBe(true)
    const restoreEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    const delayed = run({
      runId: 'run-delayed',
      turnId: 'turn-delayed',
      generationId: 'generation-delayed',
      sequence: 8,
      revision: 1,
      updatedAt: 8_000,
    })
    const payload = changes([delayed], {
      resync: true,
      lastSequence: 8,
      cursor: { version: 1, token: 'cursor-old' },
      resyncPage: { offset: 0, returnedRuns: 1, totalRuns: 1, snapshotSequence: 8, complete: true, omittedRuns: 0, omittedOlderRuns: 0 },
    })
    expect(useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, payload)).toBe(true)
    expect(useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, payload)).toBe(true)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('cursor-new')
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(10)
    expect(useStore.getState().agentRunProvisionalByKey[agentRunProvisionalKey(run())]?.turnId).toBe('turn-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
  })

  test('prefers the newest active target run and never exposes terminal runs as stoppable', () => {
    const terminal = run({
      runId: 'run-terminal',
      turnId: 'turn-terminal',
      generationId: 'generation-terminal',
      workStatus: 'terminal',
      workPhase: 'TERMINAL',
      workOutcome: 'completed',
      revision: 3,
      sequence: 30,
      updatedAt: 30_000,
      target: { messageId: 'message-shared', swipeId: 2 },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-shared',
        swipeId: 2,
        messageRevision: 6,
        swipeRevision: 2,
      },
    })
    const active = run({
      runId: 'run-active',
      turnId: 'turn-active',
      generationId: 'generation-active',
      sequence: 31,
      updatedAt: 31_000,
      target: { messageId: 'message-shared', swipeId: 2 },
    })
    const cancelled = run({
      runId: 'run-cancelled',
      turnId: 'turn-cancelled',
      generationId: 'generation-cancelled',
      workStatus: 'terminal',
      workPhase: 'TERMINAL',
      workOutcome: 'stopped',
      sequence: 40,
      updatedAt: 40_000,
    })
    useStore.setState({
      agentRunTerminalByTarget: {
        [agentRunTerminalTargetKey('chat-a', 'message-shared', 2)]: terminal,
      },
      agentRunProvisionalByKey: {
        [agentRunProvisionalKey(active)]: active,
        [agentRunProvisionalKey(cancelled)]: cancelled,
      },
    })
    expect(selectAgentRunForTarget(useStore.getState(), 'chat-a', 'message-shared', 2)?.turnId).toBe('turn-active')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a')?.turnId).toBe('turn-active')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a', 'generation-cancelled')).toBeUndefined()
  })

  test('marks invalidated sections for reload and exposes first-load failures for retry', () => {
    const indexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', indexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    const sectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', sectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)

    const newerIndexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', newerIndexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 5,
      sections: [{ section: 'tasks', count: 1, revision: 5, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks).toBeUndefined()

    const failedSectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.loadingMore).toBe(true)
    useStore.getState().failAgentWorkspaceRequest('chat-a', 'turn-a', failedSectionEpoch, 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.loadingMore).toBe(false)

    const retryEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(false)
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', retryEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 5,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(false)
  })
})
