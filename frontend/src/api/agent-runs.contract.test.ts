import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as client from './client'
import { agentRunsApi } from './agent-runs'
import type { AgentPersistentWorkspaceTurnSessionPageV1, AgentPersistentWorkspaceTurnSessionV1, AgentPersistentWorkspaceV1 } from '@/types/agent-runs'

const get = spyOn(client, 'get')
const post = spyOn(client, 'post')
const patch = spyOn(client, 'patch')
const del = spyOn(client, 'del')

afterAll(() => {
  get.mockRestore()
  post.mockRestore()
  patch.mockRestore()
  del.mockRestore()
})

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

function session(id: string, workspaceId = 'workspace-a'): AgentPersistentWorkspaceTurnSessionV1 {
  return {
    version: 1,
    id,
    workspaceId,
    userId: 'user-a',
    chatId: null,
    turnId: `turn-${id}`,
    attemptId: `attempt-${id}`,
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

beforeEach(() => {
  get.mockClear()
  post.mockClear()
  patch.mockClear()
  del.mockClear()
})

describe('agent run inspection API wire contracts', () => {
  test('targets inspection by the exact encoded attempt ID and rejects malformed aliases', async () => {
    const attemptId = 'attempt/client alias'
    get.mockResolvedValueOnce({ attemptId })

    await expect(agentRunsApi.inspection(attemptId, 'chat-a')).rejects.toThrow('Invalid owner inspection response')
    expect(get).toHaveBeenCalledWith(
      '/agent-runs/attempt%2Fclient%20alias/inspection',
      { chatId: 'chat-a' },
    )
  })

  test('posts an empty retry body and returns the server-derived attempt without aliases', async () => {
    const response = {
      version: 1 as const,
      accepted: true,
      attempt: serverAttempt,
      reason: 'reconciled' as const,
      target: serverAttempt.target,
      recoveryEligible: false,
      recoveryAction: 'none' as const,
      inspectionAttemptId: 'attempt-server',
    }
    post.mockResolvedValueOnce(response)

    await expect(agentRunsApi.retry('attempt/client alias')).resolves.toEqual(response)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/agent-runs/attempt%2Fclient%20alias/retry', {})
  })
  test('validates stop receipts against the requested turn, chat, and generation identities', async () => {
    const response = {
      version: 2 as const,
      status: 'accepted' as const,
      turnId: 'turn-a',
      revision: 2,
      target: {
        chatId: 'chat-a',
        generationType: 'normal' as const,
        messageId: 'message-a',
        swipeId: 0,
      },
      workPhase: 'WORK' as const,
      workStatus: 'cancelling' as const,
      workOutcome: null,
      reason: null,
      recoveryEligible: false,
      recoveryAction: 'none' as const,
      omissionCount: 0,
      inspectionAttemptId: 'attempt-a',
      generationId: 'generation-a',
    }
    post.mockResolvedValueOnce(response)
    await expect(agentRunsApi.stop('turn-a', { chatId: 'chat-a', generationId: 'generation-a', requestAuthorityId: '11111111-1111-4111-8111-111111111111' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-a',
      target: { chatId: 'chat-a' },
    })
    expect(post).toHaveBeenCalledWith('/agent-runs/turn-a/stop', { chatId: 'chat-a', generationId: 'generation-a', requestAuthorityId: '11111111-1111-4111-8111-111111111111' })

    post.mockResolvedValueOnce({ ...response, turnId: 'turn-b' })
    await expect(agentRunsApi.stop('turn-a', { chatId: 'chat-a', generationId: 'generation-a' })).rejects.toThrow('Invalid agent run stop response')
    post.mockResolvedValueOnce({ ...response, target: { ...response.target, chatId: 'chat-b' } })
    await expect(agentRunsApi.stop('turn-a', { chatId: 'chat-a', generationId: 'generation-a' })).rejects.toThrow('Invalid agent run stop response')
    post.mockResolvedValueOnce({ ...response, generationId: 'generation-b' })
    await expect(agentRunsApi.stop('turn-a', { chatId: 'chat-a', generationId: 'generation-a' })).rejects.toThrow('Invalid agent run stop response')
    post.mockResolvedValueOnce({ ...response, reason: undefined })
    await expect(agentRunsApi.stop('turn-a', { chatId: 'chat-a', generationId: 'generation-a' })).rejects.toThrow('Invalid agent run stop response')
  })
})


describe('persistent workspace collection API wire contracts', () => {
  test('uses the canonical submissions collection route for all public states', async () => {
    const response = [
      submission('submitted', 'submission-submitted'),
      submission('accepted', 'submission-accepted'),
      submission('rejected', 'submission-rejected'),
    ].map((item) => ({ ...item, workspaceId: 'workspace/a' }))
    get.mockResolvedValueOnce(response)

    await expect(agentRunsApi.persistentWorkspaceSubmissions('workspace/a')).resolves.toEqual(response)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/agent-runs/workspace/workspace%2Fa/submissions')
  })
  test('requests and validates bounded session pages', async () => {
    const response: AgentPersistentWorkspaceTurnSessionPageV1 = {
      data: [session('session-page', 'workspace/a')],
      total: 2,
      limit: 1,
      offset: 1,
    }
    get.mockResolvedValueOnce(response)

    await expect(agentRunsApi.persistentWorkspaceSessions('workspace/a', { limit: 1, offset: 1 })).resolves.toEqual(response)
    expect(get).toHaveBeenCalledWith('/agent-runs/workspace/workspace%2Fa/sessions', { limit: 1, offset: 1 })
  })
  test('rejects a session page whose returned offset differs from the request', async () => {
    get.mockResolvedValueOnce({
      data: [session('session-offset-mismatch', 'workspace-a')],
      total: 2,
      limit: 1,
      offset: 0,
    })

    await expect(agentRunsApi.persistentWorkspaceSessions('workspace-a', { limit: 1, offset: 1 })).rejects.toThrow('Invalid persistent workspace sessions response')
  })
  test('rejects an unbounded session collection payload', async () => {
    get.mockResolvedValueOnce([session('session-array')])

    await expect(agentRunsApi.persistentWorkspaceSessions('workspace-a')).rejects.toThrow('Invalid persistent workspace sessions response')
  })
  test('rejects hostile collection rows instead of exposing raw payloads', async () => {
    get.mockResolvedValueOnce([{ ...submission('submitted', 'submission-hostile'), workspaceId: 'workspace-other' }])

    await expect(agentRunsApi.persistentWorkspaceSubmissions('workspace-a')).rejects.toThrow('Invalid persistent workspace submissions response')
  })
  test('reloads detached workspaces by stable ID without a deleted chat scope', async () => {
    const response: AgentPersistentWorkspaceV1 = {
      version: 1,
      id: 'workspace/a',
      userId: 'user-a',
      chatId: null,
      objective: 'Preserve detached work',
      metadata: { title: 'Detached workspace', summary: 'Historical workspace', labels: [], ownerNote: '' },
      progress: { state: 'completed', percent: 100, summary: 'Complete', updatedAt: 1_100 },
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
        taskCount: 0,
        recordCount: 0,
        submissionCount: 0,
        artifactCount: 0,
        publicationCount: 0,
        byteCount: 0,
      },
      createdAt: 1_000,
      updatedAt: 1_100,
    }
    get.mockResolvedValueOnce(response)

    await expect(agentRunsApi.persistentWorkspaceById('workspace/a', null)).resolves.toEqual(response)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/agent-runs/workspace/workspace%2Fa', undefined)
  })
  test('rejects a by-id response whose identity does not match the request', async () => {
    get.mockResolvedValueOnce({
      version: 1,
      id: 'workspace-other',
      userId: 'user-a',
      chatId: null,
      objective: 'Wrong workspace',
      metadata: { title: 'Wrong', summary: 'Wrong', labels: [], ownerNote: '' },
      progress: { state: 'completed', percent: 100, summary: 'Done', updatedAt: 1_100 },
      state: 'active',
      revision: 1,
      quota: { maxTasks: 1, maxRecords: 1, maxSubmissions: 1, maxArtifacts: 1, maxPublications: 1, maxBytes: 1_000 },
      usage: { taskCount: 0, recordCount: 0, submissionCount: 0, artifactCount: 0, publicationCount: 0, byteCount: 0 },
      createdAt: 1_000,
      updatedAt: 1_100,
    })

    await expect(agentRunsApi.persistentWorkspaceById('workspace-a')).rejects.toThrow('Invalid persistent workspace response')
  })

})
