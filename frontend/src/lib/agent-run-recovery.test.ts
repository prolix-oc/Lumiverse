import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AgentRunChangesV2, AgentRunPublicV2, AgentWorkspaceIndexPublicV2 } from '@/types/agent-runs'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import { createAgentRunsSlice, selectActiveAgentRunForChat } from '@/store/slices/agent-runs'
import { loadAgentWorkspace, recoverAgentRuns as recoverAgentRunsWithDependencies } from './agent-run-recovery'
import type { AgentRunChangesApi, AgentRunRecoveryStore } from './agent-run-recovery'

type TestStore = Pick<AppStore, 'activeChatId'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))
let changesImpl: (chatId: string, cursor: string | null) => Promise<AgentRunChangesV2>
let changesCalls = 0

const recoveryApi: AgentRunChangesApi = {
  changes: (chatId, cursor) => {
    changesCalls += 1
    return changesImpl(chatId, cursor ?? null)
  },
}
const recoveryStore: AgentRunRecoveryStore = {
  getState: () => useStore.getState(),
}
const recoverAgentRuns = (chatId: string) => recoverAgentRunsWithDependencies(chatId, recoveryApi, recoveryStore)

function activeRun(overrides: Partial<AgentRunPublicV2> = {}): AgentRunPublicV2 {
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
    activity: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    ...overrides,
  }
}

function changesPayload(runs: AgentRunPublicV2[] = [activeRun()]): AgentRunChangesV2 {
  const sequence = runs.reduce((latest, run) => Math.max(latest, run.sequence), 0)
  return {
    version: 2,
    chatId: 'chat-a',
    cursor: { version: 1, token: 'cursor-a' },
    cursorSequence: sequence,
    lastSequence: sequence,
    tailSequence: sequence,
    hasMore: false,
    resync: false,
    runs,
    events: [],
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
  }
}

beforeEach(() => {
  changesCalls = 0
  changesImpl = async () => changesPayload()
  useStore.setState({
    activeChatId: 'chat-a',
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

describe('exact agent run recovery', () => {
  test('deduplicates a dropped first event recovery and restores the exact stoppable run', async () => {
    let release!: (payload: AgentRunChangesV2) => void
    changesImpl = async () => new Promise<AgentRunChangesV2>((resolve) => { release = resolve })

    const first = recoverAgentRuns('chat-a')
    const duplicate = recoverAgentRuns('chat-a')
    expect(first).toBe(duplicate)
    expect(changesCalls).toBe(1)

    release(changesPayload())
    await first

    const state = useStore.getState()

    expect(selectActiveAgentRunForChat(state, 'chat-a')).toMatchObject({ turnId: 'turn-a', generationId: 'generation-a' })
    expect(state.agentRunSyncByChat['chat-a']).toBe('ready')
  })
  test('follows bounded full-resync pages before reporting ready', async () => {
    let calls = 0
    changesImpl = async () => {
      calls += 1
      const page = calls === 1
        ? {
            resync: true,
            cursor: { version: 1 as const, token: 'resync-page-1' },
            cursorSequence: 20,
            lastSequence: 20,
            tailSequence: 20,
            hasMore: true,
            resyncPage: {
              offset: 0,
              returnedRuns: 16,
              totalRuns: 17,
              snapshotSequence: 20,
              complete: false,
              omittedRuns: 1,
              omittedOlderRuns: 0,
            },
          }
        : {
            resync: true,
            cursor: { version: 1 as const, token: 'resync-page-2' },
            cursorSequence: 20,
            lastSequence: 20,
            tailSequence: 20,
            hasMore: false,
            resyncPage: {
              offset: 16,
              returnedRuns: 1,
              totalRuns: 17,
              snapshotSequence: 20,
              complete: true,
              omittedRuns: 0,
              omittedOlderRuns: 0,
            },
          }
      const runs = calls === 1
        ? Array.from({ length: 16 }, (_, index) => activeRun({
            runId: `run-${index}`,
            turnId: `turn-${index}`,
            generationId: `generation-${index}`,
            inspectionAttemptId: `attempt-${index}`,
            attemptLineage: { ...activeRun().attemptLineage, attemptId: `attempt-${index}` },
            sequence: index + 1,
          }))
        : [activeRun({
            runId: 'run-16',
            turnId: 'turn-16',
            generationId: 'generation-16',
            inspectionAttemptId: 'attempt-16',
            attemptLineage: { ...activeRun().attemptLineage, attemptId: 'attempt-16' },
            sequence: 17,
          })]
      return {
        ...changesPayload(runs),
        ...page,
      }
    }

    await recoverAgentRuns('chat-a')
    expect(calls).toBe(2)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('resync-page-2')
  })
  test('follows delta pages advertised by the public tail sequence', async () => {
    let calls = 0
    changesImpl = async () => {
      calls += 1
      if (calls === 1) {
        return {
          ...changesPayload([activeRun({ runId: 'run-128', turnId: 'turn-128', sequence: 128 })]),
          cursor: { version: 1 as const, token: 'delta-page-1' },
          cursorSequence: 128,
          lastSequence: 128,
          tailSequence: 130,
          hasMore: true,
        }
      }
      return {
        ...changesPayload([
          activeRun({ runId: 'run-129', turnId: 'turn-129', sequence: 129 }),
          activeRun({ runId: 'run-130', turnId: 'turn-130', sequence: 130 }),
        ]),
        cursor: { version: 1 as const, token: 'delta-page-2' },
        cursorSequence: 130,
        lastSequence: 130,
        tailSequence: 130,
        hasMore: false,
      }
    }

    await recoverAgentRuns('chat-a')
    expect(calls).toBe(2)
    const state = useStore.getState()
    expect(state.agentRunCursorSequenceByChat['chat-a']).toBe(130)
    expect(state.agentRunLastSequenceByChat['chat-a']).toBe(130)
    expect(state.agentRunSyncByChat['chat-a']).toBe('ready')
  })

  test('allows a completed lookup with no run to be retried after the run becomes visible', async () => {
    changesImpl = async () => changesPayload([])
    await recoverAgentRuns('chat-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a')).toBeUndefined()

    changesImpl = async () => changesPayload()
    await recoverAgentRuns('chat-a')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a')?.turnId).toBe('turn-a')
  })

  test('terminalizes a malformed restore payload while retaining the accepted run', async () => {
    await recoverAgentRuns('chat-a')
    const retained = selectActiveAgentRunForChat(useStore.getState(), 'chat-a')
    changesImpl = async () => ({ version: 2, chatId: 'chat-a' } as unknown as AgentRunChangesV2)

    await recoverAgentRuns('chat-a')

    const state = useStore.getState()
    expect(state.agentRunSyncByChat['chat-a']).toBe('error')
    expect(selectActiveAgentRunForChat(state, 'chat-a')).toMatchObject({
      runId: retained?.runId,
      turnId: retained?.turnId,
      generationId: retained?.generationId,
    })
  })
  test('exposes a failed lookup and permits a later recovery retry', async () => {
    changesImpl = async () => { throw new Error('offline') }
    await recoverAgentRuns('chat-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('error')

    changesImpl = async () => changesPayload()
    await recoverAgentRuns('chat-a')

    const state = useStore.getState()
    expect(changesCalls).toBe(2)
    expect(selectActiveAgentRunForChat(state, 'chat-a')).toMatchObject({ turnId: 'turn-a', generationId: 'generation-a' })
  })
})

describe('workspace index refresh', () => {
  test('coalesces one signal but lets a newer signal start and rejects the late older response', async () => {
    const calls: string[] = []
    const releases: Array<(payload: AgentWorkspaceIndexPublicV2) => void> = []
    const api = {
      workspace: (turnId: string) => {
        calls.push(turnId)
        return new Promise<AgentWorkspaceIndexPublicV2>((resolve) => { releases.push(resolve) })
      },
    }

    const first = loadAgentWorkspace('chat-a', 'turn-a', 9, 4, api, recoveryStore)
    const duplicate = loadAgentWorkspace('chat-a', 'turn-a', 9, 4, api, recoveryStore)
    expect(duplicate).toBe(first)
    expect(calls).toEqual(['turn-a'])

    const newer = loadAgentWorkspace('chat-a', 'turn-a', 10, 5, api, recoveryStore)
    expect(newer).not.toBe(first)
    expect(calls).toEqual(['turn-a', 'turn-a'])

    releases[1]!({ version: 2, turnId: 'turn-a', workspaceRevision: 8, sections: [], omitted: 0 })
    await newer
    expect(useStore.getState().agentWorkspaceByTurn['turn-a']?.index?.workspaceRevision).toBe(8)

    releases[0]!({ version: 2, turnId: 'turn-a', workspaceRevision: 7, sections: [], omitted: 0 })
    await first
    expect(useStore.getState().agentWorkspaceByTurn['turn-a']?.index?.workspaceRevision).toBe(8)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a']?.status).toBe('ready')
  })
})
