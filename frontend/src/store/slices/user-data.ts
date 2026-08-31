
import type { StateCreator } from 'zustand'
import { userDataApi } from '@/api/user-data'
import {
  isUserDataJobActive,
  normalizeUserDataApiFailure,
  type DecryptionTicket,
  type UserDataFailure,
  type UserDataJob,
  type UserDataJobStatus,
} from '@/types/user-data'
import type { AppStore, UserDataSlice } from '@/types/store'
const ACTIVE_USER_DATA_JOB_KEY = 'lumiverse:user-data:active-job'
const MAX_PERSISTED_JOB_ID_BYTES = 256

function userDataJobStorageKey(userId: string): string {
  return `${ACTIVE_USER_DATA_JOB_KEY}:${encodeURIComponent(userId)}`
}

function readPersistedUserDataJobId(userId: string | null | undefined): string | null {
  if (!userId || typeof localStorage === 'undefined') return null
  try {
    const value = localStorage.getItem(userDataJobStorageKey(userId))
    return value && value.length <= MAX_PERSISTED_JOB_ID_BYTES ? value : null
  } catch {
    return null
  }
}

function persistUserDataJobId(userId: string | null | undefined, jobId: string | null): void {
  if (!userId || typeof localStorage === 'undefined') return
  try {
    const key = userDataJobStorageKey(userId)
    if (jobId && jobId.length <= MAX_PERSISTED_JOB_ID_BYTES) localStorage.setItem(key, jobId)
    else localStorage.removeItem(key)
  } catch {
    // Local persistence is only a reconnect hint; the server remains authoritative.
  }
}

export function clearUserDataJobPersistence(userId: string | null | undefined): void {
  persistUserDataJobId(userId, null)
}

type StoreCreator = StateCreator<AppStore, [], [], UserDataSlice>

function emptyJob(jobId: string, status: UserDataJobStatus): UserDataJob {
  return {
    jobId,
    archiveId: null,
    status,
    startedAt: null,
    finishedAt: null,
    updatedAt: null,
    manifest: null,
    progress: null,
    summary: { tables: {}, files: {}, secrets: { imported: 0, skipped: 0 }, vectors: null },
    failure: null,
    ticket: { required: status === 'awaiting_ticket', secretsCount: 0 },
  }
}

function shouldReplace(existing: UserDataJob | null, next: UserDataJob): boolean {
  if (!existing || existing.jobId !== next.jobId) return true
  // A late websocket/status response must never resurrect a terminal job or
  // leave the UI busy after the durable receipt is visible.
  if (!isUserDataJobActive(existing.status) && isUserDataJobActive(next.status)) {
    if (existing.updatedAt === null || next.updatedAt === null || next.updatedAt <= existing.updatedAt) return false
  }
  if (existing.updatedAt !== null && next.updatedAt !== null && next.updatedAt < existing.updatedAt) return false
  if (existing.finishedAt !== null && next.finishedAt === null && !isUserDataJobActive(existing.status)) return false
  return true
}

function actionFailure(error: unknown): UserDataFailure {
  return normalizeUserDataApiFailure(error, 'network')
}

export const createUserDataSlice: StoreCreator = (set, get) => ({
  userDataJob: null,
  userDataJobLoading: false,
  userDataJobAction: null,
  userDataJobError: null,
  userDataRequestEpoch: 0,

  setUserDataJob: (job) => {
    const userId = get().user?.id ?? null
    set((state) => {
      if (!shouldReplace(state.userDataJob, job)) return {}
      if (isUserDataJobActive(job.status)) persistUserDataJobId(userId, job.jobId)
      else persistUserDataJobId(userId, null)
      return {
        userDataJob: job,
        userDataJobError: null,
      }
    })
  },

  clearUserDataJob: () => {
    persistUserDataJobId(get().user?.id, null)
    set({
      userDataJob: null,
      userDataJobLoading: false,
      userDataJobAction: null,
      userDataJobError: null,
      userDataRequestEpoch: 0,
    })
  },

  refreshUserDataJob: async (jobId = get().userDataJob?.jobId ?? readPersistedUserDataJobId(get().user?.id)): Promise<UserDataJob | null> => {
    if (!jobId) return null
    const requestEpoch = get().userDataRequestEpoch + 1
    set({ userDataRequestEpoch: requestEpoch, userDataJobLoading: true })
    try {
      const job = await userDataApi.getImportStatus(jobId)
      if (get().userDataRequestEpoch !== requestEpoch) return null
      get().setUserDataJob(job)
      set({ userDataJobLoading: false, userDataJobError: null })
      return job
    } catch (error) {
      if (get().userDataRequestEpoch !== requestEpoch) return null
      const failure = actionFailure(error)
      if (failure.code === 'not_found') {
        persistUserDataJobId(get().user?.id, null)
        set((state) => state.userDataJob?.jobId === jobId ? { userDataJob: null } : {})
      }
      set({ userDataJobLoading: false, userDataJobError: failure })
      return null
    }
  },

  startUserDataImport: async (file, onProgress) => {
    set({ userDataJobAction: 'upload', userDataJobError: null, userDataJobLoading: true })
    try {
      const started = await userDataApi.startImport(file, onProgress)
      const initial = emptyJob(started.jobId, started.status)
      get().setUserDataJob(initial)
      set({ userDataJobAction: null, userDataJobLoading: false, userDataJobError: null })
      await get().refreshUserDataJob(started.jobId)
      return started.jobId
    } catch (error) {
      set({ userDataJobAction: null, userDataJobLoading: false, userDataJobError: actionFailure(error) })
      throw error
    }
  },

  submitUserDataTicket: async (jobId, ticket: unknown) => {
    set({ userDataJobAction: 'ticket', userDataJobError: null })
    try {
      await userDataApi.submitTicket(jobId, ticket)
      set({ userDataJobAction: null })
      await get().refreshUserDataJob(jobId)
      return true
    } catch (error) {
      set({ userDataJobAction: null, userDataJobError: actionFailure(error) })
      return false
    }
  },

  skipUserDataTicket: async (jobId) => {
    set({ userDataJobAction: 'skip-ticket', userDataJobError: null })
    try {
      await userDataApi.skipTicket(jobId)
      set({ userDataJobAction: null })
      await get().refreshUserDataJob(jobId)
      return true
    } catch (error) {
      set({ userDataJobAction: null, userDataJobError: actionFailure(error) })
      return false
    }
  },

  cancelUserDataImport: async (jobId) => {
    set({ userDataJobAction: 'cancel', userDataJobError: null })
    try {
      const result = await userDataApi.cancelImport(jobId)
      if (result.status === 'cancelled' || result.status === 'cancelling' || result.status === 'cleanup_pending') {
        const finishedAt = result.status === 'cancelled' ? Math.floor(Date.now() / 1000) : null
        const current = get().userDataJob
        if (current?.jobId === jobId) {
          get().setUserDataJob({
            ...current,
            status: result.status,
            finishedAt,
            updatedAt: Math.floor(Date.now() / 1000),
            failure: result.status === 'cancelled' ? { code: 'cancelled', message: null } : null,
          })
        }
      }
      set({ userDataJobAction: null })
      await get().refreshUserDataJob(jobId)
      return result.status
    } catch (error) {
      set({ userDataJobAction: null, userDataJobError: actionFailure(error) })
      return null
    }
  },

  reconnectUserDataJob: async (jobId) => {
    return get().refreshUserDataJob(jobId)
  },
})

export type UserDataTicketInput = DecryptionTicket | string
