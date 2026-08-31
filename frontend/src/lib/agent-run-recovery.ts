import { ApiError } from '@/api/client'
import { agentRunsApi } from '@/api/agent-runs'
import type { AgentWorkspaceSectionV2 } from '@/types/agent-runs'
import type { AgentPersistentWorkspaceCollectionV1, AgentRunsSlice } from '@/types/store'


const runRecoveryInFlight = new Map<string, Promise<void>>()
const inspectionInFlight = new Map<string, Promise<void>>()
const inspectionListInFlight = new Map<string, Promise<void>>()
const retryInFlight = new Map<string, Promise<void>>()
const workspaceIndexInFlight = new Map<string, Promise<void>>()
const workspaceSectionInFlight = new Map<string, Promise<void>>()
const persistentWorkspaceInFlight = new Map<string, Promise<void>>()
const persistentWorkspaceCollectionInFlight = new Map<string, Promise<void>>()
const MAX_RUN_RECOVERY_PAGES = 64

/** API methods needed by owner-inspection and persistent-workspace recovery. */
export interface AgentRunRecoveryApi {
  inspection: typeof agentRunsApi.inspection
  retry: typeof agentRunsApi.retry
  persistentWorkspace: typeof agentRunsApi.persistentWorkspace
  persistentWorkspaceById: typeof agentRunsApi.persistentWorkspaceById
  persistentWorkspaceSessions: typeof agentRunsApi.persistentWorkspaceSessions
  persistentWorkspaceTasks: typeof agentRunsApi.persistentWorkspaceTasks
  persistentWorkspaceRecords: typeof agentRunsApi.persistentWorkspaceRecords
  persistentWorkspaceArtifacts: typeof agentRunsApi.persistentWorkspaceArtifacts
  persistentWorkspaceSubmissions: typeof agentRunsApi.persistentWorkspaceSubmissions
  persistentWorkspacePublications: typeof agentRunsApi.persistentWorkspacePublications
}
/** Narrow store seam keeps recovery tests isolated without replacing the application module. */
export type AgentRunRecoveryStore = {
  getState: () => Pick<
    AgentRunsSlice,
    | 'agentRunCursorByChat'
    | 'agentRunCursorSequenceByChat'
    | 'agentRunLastSequenceByChat'
    | 'beginAgentRunRestore'
    | 'applyAgentRunChanges'
    | 'failAgentRunRestore'
    | 'beginAgentRunInspection'
    | 'applyAgentRunInspection'
    | 'failAgentRunInspection'
    | 'beginAgentRunInspectionList'
    | 'applyAgentRunInspectionList'
    | 'failAgentRunInspectionList'
    | 'beginAgentRunRetry'
    | 'applyAgentRunRetry'
    | 'failAgentRunRetry'
    | 'beginPersistentWorkspaceRequest'
    | 'applyPersistentWorkspace'
    | 'failPersistentWorkspaceRequest'
    | 'beginPersistentWorkspaceCollection'
    | 'applyPersistentWorkspaceCollection'
    | 'failPersistentWorkspaceCollection'
    | 'agentWorkspaceByTurn'
    | 'beginAgentWorkspaceRequest'
    | 'applyAgentWorkspaceIndex'
    | 'applyAgentWorkspaceSection'
    | 'failAgentWorkspaceRequest'
  >
}

export type AgentRunChangesApi = Pick<typeof agentRunsApi, 'changes'>
type AgentRunInspectionListApi = Pick<typeof agentRunsApi, 'listInspection'>
type AgentRunPersistentWorkspaceApi = Pick<typeof agentRunsApi, 'persistentWorkspace' | 'persistentWorkspaceById'>
type AgentRunWorkspaceApi = Pick<typeof agentRunsApi, 'workspace'>
type AgentRunWorkspaceSectionApi = Pick<typeof agentRunsApi, 'workspaceSection'>

function inspectionFailureAvailability(error: unknown): 'missing' | 'deleted' | 'unavailable' | 'stale' {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'missing'
    if (error.status === 410) return 'deleted'
    if (error.status === 409) return 'stale'
  }
  return 'unavailable'
}
function persistentWorkspaceScope(chatId: string | null | undefined, workspaceId?: string | null): string {
  return workspaceId ? `id:${workspaceId}` : `chat:${chatId ?? ''}`
}
function requestErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null
}
function persistentWorkspaceFailureAvailability(error: unknown): 'missing' | 'deleted' | 'unavailable' | 'detached' {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'missing'
    if (error.status === 410) return 'deleted'
  }
  return 'unavailable'
}

/** Restore one chat from its opaque cursor without replacing a newer chat/request epoch. */
export function recoverAgentRuns(
  chatId: string,
  api: AgentRunChangesApi,
  store: AgentRunRecoveryStore,
): Promise<void> {

  if (!chatId) return Promise.resolve()
  const existing = runRecoveryInFlight.get(chatId)
  if (existing) return existing

  const state = store.getState()
  const requestEpoch = state.beginAgentRunRestore(chatId)
  const request = (async () => {
    let cursor = store.getState().agentRunCursorByChat[chatId] ?? null
    for (let page = 0; page < MAX_RUN_RECOVERY_PAGES; page += 1) {
      const payload = await api.changes(chatId, cursor)
      const applied = store.getState().applyAgentRunChanges(chatId, requestEpoch, payload)
      if (!applied) {
        // A malformed or out-of-scope response must not leave the chat in
        // `restoring`; the epoch guard in the store preserves any newer retry.
        store.getState().failAgentRunRestore(chatId, requestEpoch)
        return
      }
      const current = store.getState()
      const incompleteResync = payload.resync
        && payload.resyncPage?.complete === false
      const cursorBehindPublic = (
        (current.agentRunCursorSequenceByChat[chatId] ?? 0)
        < (current.agentRunLastSequenceByChat[chatId] ?? 0)
      )
      if (!payload.hasMore && !incompleteResync && !cursorBehindPublic) return
      const nextCursor = current.agentRunCursorByChat[chatId] ?? cursor
      if (!nextCursor || nextCursor === cursor && !incompleteResync && !payload.hasMore) return
      cursor = nextCursor
    }
  })()
    .catch(() => {
      store.getState().failAgentRunRestore(chatId, requestEpoch)
    })
    .finally(() => {
      runRecoveryInFlight.delete(chatId)
    })
  runRecoveryInFlight.set(chatId, request)
  return request
}
/** Load private causal inspection only after an owner expands a run. */
export function loadAgentRunInspection(
  chatId: string,
  attemptId: string,
  api: AgentRunRecoveryApi,
  store: AgentRunRecoveryStore,
): Promise<void> {

  if (!chatId || !attemptId) return Promise.resolve()
  const key = `${chatId}:${attemptId}`
  const existing = inspectionInFlight.get(key)
  if (existing) return existing
  const state = store.getState()
  const requestEpoch = state.beginAgentRunInspection(chatId, attemptId)
  const request = api.inspection(attemptId, chatId)
    .then((payload) => {
      store.getState().applyAgentRunInspection(chatId, attemptId, requestEpoch, payload)
    })
    .catch((error) => {
      store.getState().failAgentRunInspection(chatId, attemptId, requestEpoch, inspectionFailureAvailability(error), null)
    })
    .finally(() => {
      inspectionInFlight.delete(key)
    })
  inspectionInFlight.set(key, request)
  return request
}

export function loadAgentRunInspectionList(
  chatId: string,
  api: AgentRunInspectionListApi,
  store: AgentRunRecoveryStore,
): Promise<void> {

  if (!chatId) return Promise.resolve()
  const existing = inspectionListInFlight.get(chatId)
  if (existing) return existing
  const state = store.getState()
  const requestEpoch = state.beginAgentRunInspectionList(chatId)
  const request = api.listInspection(chatId)
    .then((payload) => {
      store.getState().applyAgentRunInspectionList(chatId, requestEpoch, payload)
    })
    .catch(() => {
      store.getState().failAgentRunInspectionList(chatId, requestEpoch, null)
    })
    .finally(() => {
      inspectionListInFlight.delete(chatId)
    })
  inspectionListInFlight.set(chatId, request)
  return request
}

export function retryAgentRunInspection(
  attemptId: string,
  api: AgentRunRecoveryApi,
  store: AgentRunRecoveryStore,
): Promise<void> {

  if (!attemptId) return Promise.resolve()
  const existing = retryInFlight.get(attemptId)
  if (existing) return existing
  store.getState().beginAgentRunRetry(attemptId)
  const request = api.retry(attemptId)
    .then((payload) => {
      store.getState().applyAgentRunRetry(attemptId, payload)
    })
    .catch(() => {
      store.getState().failAgentRunRetry(attemptId, null)
    })
    .finally(() => {
      retryInFlight.delete(attemptId)
    })
  retryInFlight.set(attemptId, request)
  return request
}

export function loadPersistentWorkspace(
  chatId: string | null | undefined,
  api: AgentRunPersistentWorkspaceApi,
  store: AgentRunRecoveryStore,
  workspaceId?: string | null,
): Promise<void> {

  if (!chatId && !workspaceId) return Promise.resolve()
  const scope = persistentWorkspaceScope(chatId, workspaceId)
  const existing = persistentWorkspaceInFlight.get(scope)
  if (existing) return existing
  const requestEpoch = store.getState().beginPersistentWorkspaceRequest(scope)
  const request = (workspaceId
    ? api.persistentWorkspaceById(workspaceId)
    : api.persistentWorkspace(chatId!)
  )
    .then((payload) => {
      store.getState().applyPersistentWorkspace(scope, requestEpoch, payload)
    })
    .catch((error) => {
      store.getState().failPersistentWorkspaceRequest(
        scope,
        requestEpoch,
        persistentWorkspaceFailureAvailability(error),
        requestErrorMessage(error),
      )
    })
    .finally(() => {
      persistentWorkspaceInFlight.delete(scope)
    })
  persistentWorkspaceInFlight.set(scope, request)
  return request
}

function requestPersistentWorkspaceCollection(
  workspaceId: string,
  collection: AgentPersistentWorkspaceCollectionV1,
  api: AgentRunRecoveryApi,
) {
  if (collection === 'sessions') return api.persistentWorkspaceSessions(workspaceId)
  if (collection === 'tasks') return api.persistentWorkspaceTasks(workspaceId)
  if (collection === 'records') return api.persistentWorkspaceRecords(workspaceId)
  if (collection === 'artifacts') return api.persistentWorkspaceArtifacts(workspaceId)
  if (collection === 'submissions') return api.persistentWorkspaceSubmissions(workspaceId)
  return api.persistentWorkspacePublications(workspaceId)
}

export function loadPersistentWorkspaceCollection(
  workspaceId: string,
  collection: AgentPersistentWorkspaceCollectionV1,
  api: AgentRunRecoveryApi,
  store: AgentRunRecoveryStore,
): Promise<void> {
  if (!workspaceId) return Promise.resolve()
  const key = `${workspaceId}:${collection}`
  const existing = persistentWorkspaceCollectionInFlight.get(key)
  if (existing) return existing
  const requestEpoch = store.getState().beginPersistentWorkspaceCollection(workspaceId, collection)
  const request = requestPersistentWorkspaceCollection(workspaceId, collection, api)
    .then((payload) => {
      store.getState().applyPersistentWorkspaceCollection(workspaceId, collection, requestEpoch, payload)
    })
    .catch((error) => {
      store.getState().failPersistentWorkspaceCollection(workspaceId, collection, requestEpoch, requestErrorMessage(error))
    })
    .finally(() => {
      persistentWorkspaceCollectionInFlight.delete(key)
    })
  persistentWorkspaceCollectionInFlight.set(key, request)
  return request
}

/** Fetch the workspace index separately from activity; no workspace bytes enter run events. */
export function loadAgentWorkspace(
  chatId: string,
  turnId: string,
  runSequence: number,
  runRevision: number,
  api: AgentRunWorkspaceApi,
  store: AgentRunRecoveryStore,
): Promise<void> {
  const key = `${chatId}:${turnId}:sequence:${runSequence}:revision:${runRevision}`
  const existing = workspaceIndexInFlight.get(key)
  if (existing) return existing

  const requestEpoch = store.getState().beginAgentWorkspaceRequest(chatId, turnId)
  const request = api.workspace(turnId)
    .then((payload) => {
      store.getState().applyAgentWorkspaceIndex(chatId, turnId, requestEpoch, payload)
    })
    .catch(() => {
      store.getState().failAgentWorkspaceRequest(chatId, turnId, requestEpoch)
    })
    .finally(() => {
      workspaceIndexInFlight.delete(key)
    })
  workspaceIndexInFlight.set(key, request)
  return request
}

export function loadAgentWorkspaceSection(
  chatId: string,
  turnId: string,
  section: AgentWorkspaceSectionV2,
  api: AgentRunWorkspaceSectionApi,
  store: AgentRunRecoveryStore,
  append = false,
): Promise<void> {
  const state = store.getState()
  const page = append ? state.agentWorkspaceByTurn[turnId]?.sections[section]?.preview.nextPage ?? null : null
  const revision = state.agentWorkspaceByTurn[turnId]?.index?.workspaceRevision
  const key = `${chatId}:${turnId}:${section}:revision:${revision ?? 'none'}${append ? `:page:${page ?? 'none'}` : ':index'}`
  const existing = workspaceSectionInFlight.get(key)
  if (existing) return existing
  if (append && !page) return Promise.resolve()
  const requestEpoch = state.beginAgentWorkspaceRequest(chatId, turnId, section)
  const request = api.workspaceSection(turnId, section, page, revision)
    .then((payload) => {
      store.getState().applyAgentWorkspaceSection(
        chatId,
        turnId,
        section,
        requestEpoch,
        payload,
        append,
      )
    })
    .catch(() => {
      store.getState().failAgentWorkspaceRequest(chatId, turnId, requestEpoch, section)
    })
    .finally(() => {
      workspaceSectionInFlight.delete(key)
    })
  workspaceSectionInFlight.set(key, request)
  return request
}
