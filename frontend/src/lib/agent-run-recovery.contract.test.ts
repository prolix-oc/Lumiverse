import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import { ApiError } from '@/api/client'
import { agentRunsApi } from '@/api/agent-runs'
import type {
  AgentPersistentWorkspaceSubmissionV1,
  AgentRunInspectionDetailV1,
  AgentRunInspectionRetryResponseV1,
} from '@/types/agent-runs'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import { createAgentRunsSlice } from '@/store/slices/agent-runs'
import {
  loadAgentRunInspection,
  loadPersistentWorkspace,
  loadPersistentWorkspaceCollection,
  retryAgentRunInspection,
} from './agent-run-recovery'
import type { AgentRunRecoveryApi, AgentRunRecoveryStore } from './agent-run-recovery'

type TestStore = Pick<AppStore, 'activeChatId'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))

let inspectionImpl: (attemptId: string, chatId?: string) => Promise<AgentRunInspectionDetailV1>
let retryImpl: (attemptId: string) => Promise<AgentRunInspectionRetryResponseV1>
let submissionsImpl: (workspaceId: string) => Promise<AgentPersistentWorkspaceSubmissionV1[]>
let persistentWorkspaceImpl: typeof agentRunsApi.persistentWorkspace
let persistentWorkspaceByIdImpl: typeof agentRunsApi.persistentWorkspaceById
let persistentWorkspaceRequests: string[] = []
let persistentWorkspaceByIdRequests: Array<{ workspaceId: string; chatId?: string | null }> = []
let inspectionRequests: Array<{ attemptId: string; chatId?: string }> = []
const recoveryApi: AgentRunRecoveryApi = {
  ...agentRunsApi,
  inspection: (attemptId, chatId) => {
    inspectionRequests.push({ attemptId, chatId })
    return inspectionImpl(attemptId, chatId)
  },
  retry: (attemptId) => retryImpl(attemptId),
  persistentWorkspace: (chatId) => {
    persistentWorkspaceRequests.push(chatId)
    return persistentWorkspaceImpl(chatId)
  },
  persistentWorkspaceById: (workspaceId, chatId) => {
    persistentWorkspaceByIdRequests.push({ workspaceId, chatId })
    return persistentWorkspaceByIdImpl(workspaceId, chatId)
  },
  persistentWorkspaceSubmissions: (workspaceId) => submissionsImpl(workspaceId),
}

const recoveryStore: AgentRunRecoveryStore = {
  getState: () => useStore.getState(),
}

const serverAttempt = {
  version: 1 as const,
  attemptId: 'attempt-server',
  previousAttemptId: null,
  target: {
    chatId: 'chat-a',
    generationType: 'normal' as const,
    messageId: 'message-a',
    swipeId: 0,
  },
  createdAt: 1_000,
}

function retryResponse() {
  return {
    version: 1 as const,
    accepted: false,
    attempt: serverAttempt,
    reason: 'needs_attention' as const,
    target: serverAttempt.target,
    recoveryEligible: true,
    recoveryAction: 'repair' as const,
    inspectionAttemptId: 'attempt-server',
  }
}

function submission(state: 'submitted' | 'accepted' | 'rejected', id: string) {
  return {
    version: 1 as const,
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
  }
}

beforeEach(() => {
  inspectionImpl = async () => {
    throw new Error('inspection implementation not configured')
  }
  retryImpl = async () => retryResponse()
  submissionsImpl = async () => []
  persistentWorkspaceImpl = async () => {
    throw new Error('persistent workspace implementation not configured')
  }
  persistentWorkspaceByIdImpl = async () => {
    throw new Error('persistent workspace by ID implementation not configured')
  }
  persistentWorkspaceRequests = []
  persistentWorkspaceByIdRequests = []
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

describe('public owner inspection recovery', () => {
  test('maps explicit 404, 410, and 409 responses to canonical availability states', async () => {
    const transitions = [
      [404, 'missing'],
      [410, 'deleted'],
      [409, 'stale'],
    ] as const

    for (const [status, availability] of transitions) {
      inspectionImpl = async () => {
        throw new ApiError(status, `status-${status}`)
      }
      await loadAgentRunInspection('chat-a', 'attempt-a', recoveryApi, recoveryStore)
      expect(useStore.getState().agentRunInspectionByAttemptId['attempt-a']).toMatchObject({
        status: 'error',
        availability,
        detail: null,
        error: null,
      })
    }
  })

  test('passes the exact attempt and chat IDs without local aliases', async () => {
    const requests: Array<{ attemptId: string; chatId?: string }> = []
    const scopedApi: AgentRunRecoveryApi = {
      ...recoveryApi,
      inspection: (attemptId, chatId) => {
        requests.push({ attemptId, chatId })
        return inspectionImpl(attemptId, chatId)
      },
    }
    inspectionImpl = async () => {
      throw new ApiError(404, 'missing')
    }

    await loadAgentRunInspection('chat-a', 'attempt/client alias', scopedApi, recoveryStore)
    expect(requests).toEqual([{
      attemptId: 'attempt/client alias',
      chatId: 'chat-a',
    }])
  })

  test('keeps server recovery action and target fields while refusal remains refusal', async () => {
    let requestedAttemptId = ''
    retryImpl = async (attemptId) => {
      requestedAttemptId = attemptId
      return retryResponse()
    }

    await retryAgentRunInspection('attempt/client alias', recoveryApi, recoveryStore)

    expect(requestedAttemptId).toBe('attempt/client alias')
    expect(useStore.getState().agentRunRetryByAttemptId['attempt/client alias']).toMatchObject({
      status: 'refused',
      response: {
        accepted: false,
        recoveryEligible: true,
        recoveryAction: 'repair',
        attempt: { attemptId: 'attempt-server' },
        target: serverAttempt.target,
      },
    })
  })
})

describe('public Persistent Workspace recovery', () => {
  test('loads canonical submission DTOs through the public collection action', async () => {
    const submissions = [
      submission('submitted', 'submission-submitted'),
      submission('accepted', 'submission-accepted'),
      submission('rejected', 'submission-rejected'),
    ]
    let requestedWorkspaceId = ''
    submissionsImpl = async (workspaceId) => {
      requestedWorkspaceId = workspaceId
      return submissions
    }
    useStore.setState({
      agentPersistentWorkspaceById: {
        'workspace-a': {
          status: 'ready',
          availability: 'detached',
          workspace: {
            version: 1,
            id: 'workspace-a',
            userId: 'user-a',
            chatId: null,
            objective: 'Retain detached work',
            metadata: { title: 'Workspace A', summary: '', labels: [], ownerNote: '' },
            progress: { state: 'in_progress', percent: 50, summary: '', updatedAt: 1_100 },
            state: 'active',
            revision: 1,
            quota: { maxTasks: 10, maxRecords: 10, maxSubmissions: 10, maxArtifacts: 10, maxPublications: 10, maxBytes: 10_000 },
            usage: { taskCount: 0, recordCount: 0, submissionCount: 3, artifactCount: 0, publicationCount: 0, byteCount: 0 },
            createdAt: 1_000,
            updatedAt: 1_100,
          },
          error: null,
          requestEpoch: 1,
        },
      },
    })

    await loadPersistentWorkspaceCollection('workspace-a', 'submissions', recoveryApi, recoveryStore)

    expect(requestedWorkspaceId).toBe('workspace-a')
    expect(useStore.getState().agentPersistentWorkspaceCollectionsById['workspace-a']?.submissions).toEqual({
      status: 'ready',
      items: submissions,
      error: null,
    })
  })
  test('uses the stable workspace ID after source deletion despite a retained chat ID', async () => {
    persistentWorkspaceByIdImpl = async () => {
      throw new ApiError(404, 'detached workspace missing')
    }

    await loadPersistentWorkspace('chat-deleted', recoveryApi, recoveryStore, 'workspace-a')

    expect(persistentWorkspaceRequests).toEqual([])
    expect(persistentWorkspaceByIdRequests).toEqual([{
      workspaceId: 'workspace-a',
      chatId: undefined,
    }])
    expect(useStore.getState().agentPersistentWorkspaceRequestEpochByKey).toEqual({
      'id:workspace-a': 1,
    })
    expect(useStore.getState().agentPersistentWorkspaceById['workspace-a']).toMatchObject({
      status: 'error',
      availability: 'missing',
      workspace: null,
    })
  })

})
