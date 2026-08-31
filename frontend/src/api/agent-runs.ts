import { del, get, patch, post } from './client'
import {
  normalizeAgentRunInspectionDetailV1,
  normalizeAgentRunInspectionListV1,
  normalizeAgentRunInspectionRetryResponseV1,
  normalizeAgentRunStopResultV2,
  normalizePersistentWorkspace,
  normalizePersistentWorkspaceCollection,
  normalizePersistentWorkspaceTurnSessionPage,
} from '@/store/slices/agent-runs'
import type { AgentPersistentWorkspaceCollectionV1 } from '@/types/store'
import type {
  AgentPersistentWorkspaceCreateInputV1,
  AgentPersistentWorkspaceDeletionResultV1,
  AgentPersistentWorkspaceEditInputV1,
  AgentPersistentWorkspacePublicationInputV1,
  AgentPersistentWorkspaceTaskInputV1,
  AgentPersistentWorkspaceTurnSessionPageV1,
  AgentPersistentWorkspaceV1,
  AgentRunChangesV2,
  AgentRunInspectionDetailV1,
  AgentRunInspectionListV1,
  AgentRunInspectionRetryResponseV1,
  AgentRunPublicV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
} from '@/types/agent-runs'


function requireInspectionDetail(payload: unknown, expectedAttemptId?: string, expectedChatId?: string): AgentRunInspectionDetailV1 {
  const detail = normalizeAgentRunInspectionDetailV1(payload, expectedAttemptId, expectedChatId)
  if (!detail) throw new Error('Invalid owner inspection response')
  return detail
}

function requireInspectionList(payload: unknown, expectedChatId?: string): AgentRunInspectionListV1 {
  const list = normalizeAgentRunInspectionListV1(payload)
  if (!list || expectedChatId !== undefined && list.chatId !== expectedChatId) throw new Error('Invalid owner inspection list response')
  return list
}

function requirePersistentWorkspace(payload: unknown, expectedWorkspaceId?: string, expectedChatId?: string | null): AgentPersistentWorkspaceV1 {
  const workspace = normalizePersistentWorkspace(payload, expectedWorkspaceId, expectedChatId)
  if (!workspace) throw new Error('Invalid persistent workspace response')
  return workspace
}

function requirePersistentWorkspaceCollection<C extends AgentPersistentWorkspaceCollectionV1>(
  collection: C,
  workspaceId: string,
  payload: unknown,
) {
  const items = normalizePersistentWorkspaceCollection(collection, payload, workspaceId)
  if (!items) throw new Error(`Invalid persistent workspace ${collection} response`)
  return items
}
function requirePersistentWorkspaceSessionsPage(
  workspaceId: string,
  payload: unknown,
  expectedOffset?: number,
): AgentPersistentWorkspaceTurnSessionPageV1 {
  const page = normalizePersistentWorkspaceTurnSessionPage(payload, workspaceId, expectedOffset)
  if (!page) throw new Error('Invalid persistent workspace sessions response')
  return page
}

function requirePersistentWorkspaceItem<C extends AgentPersistentWorkspaceCollectionV1>(
  collection: C,
  workspaceId: string,
  payload: unknown,
) {
  const items = requirePersistentWorkspaceCollection(collection, workspaceId, [payload])
  return items[0]!
}

function requireInspectionRetry(payload: unknown): AgentRunInspectionRetryResponseV1 {
  const response = normalizeAgentRunInspectionRetryResponseV1(payload)
  if (!response) throw new Error('Invalid owner inspection retry response')
  return response
}
const base = '/agent-runs'

export const agentRunsApi = {
  changes(chatId: string, cursor?: string | null) {
    return get<AgentRunChangesV2>(`${base}/changes/${chatId}`, cursor ? { cursor } : undefined)
  },

  status(turnId: string) {
    return get<AgentRunPublicV2>(`${base}/status/${turnId}`)
  },
  async listInspection(chatId: string, params?: { limit?: number; cursor?: string | null }) {
    const payload = await get<unknown>(`${base}/inspection`, { chatId, ...params })
    return requireInspectionList(payload, chatId)
  },

  async inspection(attemptId: string, chatId?: string) {
    const payload = await get<unknown>(
      `${base}/${encodeURIComponent(attemptId)}/inspection`,
      chatId ? { chatId } : undefined,
    )
    return requireInspectionDetail(payload, attemptId, chatId)
  },

  async retry(attemptId: string) {
    const payload = await post<unknown>(`${base}/${encodeURIComponent(attemptId)}/retry`, {})
    return requireInspectionRetry(payload)
  },

  workspace(turnId: string) {
    return get<AgentWorkspaceIndexPublicV2>(`${base}/${turnId}/workspace`)
  },
  async persistentWorkspace(chatId: string) {
    const payload = await get<unknown>(`${base}/workspace`, { chatId })
    return requirePersistentWorkspace(payload, undefined, chatId)
  },

  async createPersistentWorkspace(
    chatId: string,
    input: Omit<AgentPersistentWorkspaceCreateInputV1, 'chatId'>,
  ) {
    const payload = await post<unknown>(`${base}/workspace?chatId=${encodeURIComponent(chatId)}`, input)
    return requirePersistentWorkspace(payload, undefined, chatId)
  },

  async persistentWorkspaceById(workspaceId: string, chatId?: string | null) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}`,
      chatId === undefined || chatId === null ? undefined : { chatId },
    )
    return requirePersistentWorkspace(payload, workspaceId, chatId)
  },

  async editPersistentWorkspace(workspaceId: string, input: AgentPersistentWorkspaceEditInputV1) {
    const payload = await patch<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}`,
      input,
    )
    return requirePersistentWorkspace(payload, workspaceId)
  },

  deletePersistentWorkspace(workspaceId: string, expectedRevision: number) {
    return del<AgentPersistentWorkspaceDeletionResultV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}?expectedRevision=${expectedRevision}`,
    )
  },

  async persistentWorkspaceSessions(workspaceId: string, params?: { limit?: number; offset?: number }) {
    const path = `${base}/workspace/${encodeURIComponent(workspaceId)}/sessions`
    const payload = params === undefined
      ? await get<unknown>(path)
      : await get<unknown>(path, params)
    return requirePersistentWorkspaceSessionsPage(workspaceId, payload, params?.offset)
  },
  async persistentWorkspaceSubmissions(workspaceId: string) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/submissions`,
    )
    return requirePersistentWorkspaceCollection('submissions', workspaceId, payload)
  },

  async persistentWorkspaceTasks(workspaceId: string) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/tasks`,
    )
    return requirePersistentWorkspaceCollection('tasks', workspaceId, payload)
  },

  async createPersistentWorkspaceTask(workspaceId: string, input: AgentPersistentWorkspaceTaskInputV1) {
    const payload = await post<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/tasks`,
      input,
    )
    return requirePersistentWorkspaceItem('tasks', workspaceId, payload)
  },

  async persistentWorkspaceRecords(workspaceId: string) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/records`,
    )
    return requirePersistentWorkspaceCollection('records', workspaceId, payload)
  },

  async persistentWorkspaceArtifacts(workspaceId: string) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/artifacts`,
    )
    return requirePersistentWorkspaceCollection('artifacts', workspaceId, payload)
  },

  async persistentWorkspacePublications(workspaceId: string) {
    const payload = await get<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications`,
    )
    return requirePersistentWorkspaceCollection('publications', workspaceId, payload)
  },

  async publishPersistentWorkspace(workspaceId: string, input: AgentPersistentWorkspacePublicationInputV1) {
    const payload = await post<unknown>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications`,
      input,
    )
    return requirePersistentWorkspaceItem('publications', workspaceId, payload)
  },

  deletePersistentWorkspacePublication(
    workspaceId: string,
    publicationId: string,
    expectedRevision: number,
  ) {
    return del<AgentPersistentWorkspaceDeletionResultV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications/${encodeURIComponent(publicationId)}?expectedRevision=${expectedRevision}`,
    )
  },

  workspaceSection(
    turnId: string,
    section: AgentWorkspaceSectionV2,
    page?: string | null,
    revision?: number,
  ) {
    return get<AgentWorkspaceSectionPreviewV2>(
      `${base}/${turnId}/workspace/${section}`,
      page || revision !== undefined ? { ...(page ? { page } : {}), ...(revision !== undefined ? { revision } : {}) } : undefined,
    )
  },
  async stop(turnId: string, input?: { generationId?: string; chatId?: string; requestAuthorityId?: string }) {
    const payload = await post<unknown>(`${base}/${turnId}/stop`, input ?? {})
    const result = normalizeAgentRunStopResultV2(payload, turnId, input?.chatId, input?.generationId)
    if (!result) throw new Error('Invalid agent run stop response')
    return result
  },
}
