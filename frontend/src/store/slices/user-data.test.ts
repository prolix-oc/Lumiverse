import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { UserDataSlice } from '@/types/store'
import { clearUserDataJobPersistence, createUserDataSlice } from './user-data'
import { userDataApi } from '@/api/user-data'
import type { UserDataJob } from '@/types/user-data'
type TestStore = UserDataSlice & { user: { id: string } | null }
const useStore = create<TestStore>()((set, get, api) => createUserDataSlice(
  set as unknown as Parameters<typeof createUserDataSlice>[0],
  get as unknown as Parameters<typeof createUserDataSlice>[1],
  api as unknown as Parameters<typeof createUserDataSlice>[2],
) as UserDataSlice & { user: { id: string } | null })

function job(status: UserDataJob['status'], updatedAt: number | null): UserDataJob {
  return {
    jobId: 'persisted-job',
    archiveId: 'archive-1',
    status,
    startedAt: 1,
    finishedAt: status === 'complete' ? 2 : null,
    updatedAt,
    manifest: null,
    progress: status === 'running' ? { phase: 'files', table: null, processed: 1, total: 2 } : null,
    summary: { tables: {}, files: {}, secrets: { imported: 0, skipped: 0 }, vectors: null },
    failure: null,
    ticket: { required: false, secretsCount: 0 },
  }
}
const originalLocalStorage = globalThis.localStorage
let localValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localValues.set(key, value) },
  removeItem: (key: string) => { localValues.delete(key) },
}

function installLocalStorage(): void {
  localValues = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: testLocalStorage,
  })
}

beforeEach(() => {
  installLocalStorage()
  useStore.setState({
    user: { id: 'account-a' },
    userDataJob: null,
    userDataJobLoading: false,
    userDataJobAction: null,
    userDataJobError: null,
    userDataRequestEpoch: 0,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: originalLocalStorage,
  })
})

describe('user-data portability store', () => {
  test('retains a durable terminal receipt against a late reconnect progress event', () => {
    useStore.getState().setUserDataJob(job('running', 10))
    useStore.getState().setUserDataJob(job('complete', 20))
    useStore.getState().setUserDataJob(job('running', 19))
    expect(useStore.getState().userDataJob?.status).toBe('complete')
  })

  test('permits a newer persisted status to replace the in-memory placeholder', () => {
    useStore.getState().setUserDataJob(job('queued', null))
    useStore.getState().setUserDataJob(job('awaiting_ticket', 30))
    expect(useStore.getState().userDataJob?.status).toBe('awaiting_ticket')
  })
  test('stores only the active opaque job ID in an account-scoped key', () => {
    useStore.getState().setUserDataJob(job('running', 10))
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBe('persisted-job')

    useStore.setState({ user: { id: 'account-b' } })
    useStore.getState().setUserDataJob(job('running', 11))
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBe('persisted-job')
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-b')).toBe('persisted-job')

    clearUserDataJobPersistence('account-b')
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-b')).toBeNull()
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBe('persisted-job')
  })

  test('clears the active reconnect hint when a terminal receipt is observed', () => {
    useStore.getState().setUserDataJob(job('running', 10))
    useStore.getState().setUserDataJob(job('complete', 20))
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBeNull()
  })

  test('reconnects a persisted job ID after the in-memory store is reset', async () => {
    useStore.getState().setUserDataJob(job('running', 10))
    useStore.setState({ userDataJob: null })
    const originalGetImportStatus = userDataApi.getImportStatus
    let requestedJobId: string | null = null
    userDataApi.getImportStatus = async (jobId) => {
      requestedJobId = jobId
      return job('running', 30)
    }
    try {
      await useStore.getState().reconnectUserDataJob()
    } finally {
      userDataApi.getImportStatus = originalGetImportStatus
    }
    expect(requestedJobId).toBe('persisted-job')
    expect(useStore.getState().userDataJob?.status).toBe('running')
  })

  test('cancels an active import and settles on the durable cancelled receipt', async () => {
    const now = Math.floor(Date.now() / 1000)
    useStore.getState().setUserDataJob(job('running', now))
    const originalCancel = userDataApi.cancelImport
    const originalGetImportStatus = userDataApi.getImportStatus
    userDataApi.cancelImport = async () => ({ status: 'cancelling' as const })
    userDataApi.getImportStatus = async () => ({
      ...job('cancelled', now + 10),
      finishedAt: now + 10,
      failure: { code: 'cancelled' as const, message: null },
    })
    let reported: string | null = null
    try {
      reported = await useStore.getState().cancelUserDataImport('persisted-job')
    } finally {
      userDataApi.cancelImport = originalCancel
      userDataApi.getImportStatus = originalGetImportStatus
    }
    expect(reported).toBe('cancelling')
    expect(useStore.getState().userDataJob?.status).toBe('cancelled')
    expect(useStore.getState().userDataJobAction).toBeNull()
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBeNull()
  })

  test('keeps a committing job after a too-late cancellation', async () => {
    const now = Math.floor(Date.now() / 1000)
    useStore.getState().setUserDataJob({ ...job('running', now), status: 'committing' })
    const originalCancel = userDataApi.cancelImport
    const originalGetImportStatus = userDataApi.getImportStatus
    userDataApi.cancelImport = async () => ({ status: 'too_late' as const })
    userDataApi.getImportStatus = async () => ({ ...job('running', now + 1), status: 'committing' as const })
    let reported: string | null = null
    try {
      reported = await useStore.getState().cancelUserDataImport('persisted-job')
    } finally {
      userDataApi.cancelImport = originalCancel
      userDataApi.getImportStatus = originalGetImportStatus
    }
    expect(reported).toBe('too_late')
    expect(useStore.getState().userDataJob?.status).toBe('committing')
    expect(useStore.getState().userDataJobAction).toBeNull()
  })

  test('drops a stale reconnect hint when the server no longer knows the job', async () => {
    useStore.getState().setUserDataJob(job('running', 10))
    const originalGetImportStatus = userDataApi.getImportStatus
    userDataApi.getImportStatus = async () => {
      throw Object.assign(new Error('import job not found'), { body: { code: 'not_found' } })
    }
    try {
      await useStore.getState().refreshUserDataJob('persisted-job')
    } finally {
      userDataApi.getImportStatus = originalGetImportStatus
    }
    expect(useStore.getState().userDataJob).toBeNull()
    expect(useStore.getState().userDataJobError?.code).toBe('not_found')
    expect(useStore.getState().userDataJobLoading).toBe(false)
    expect(localStorage.getItem('lumiverse:user-data:active-job:account-a')).toBeNull()
  })

  test('never resumes another account persisted job after an account switch', async () => {
    useStore.getState().setUserDataJob(job('running', 10))
    useStore.setState({ user: { id: 'account-b' }, userDataJob: null })
    const originalGetImportStatus = userDataApi.getImportStatus
    let requests = 0
    userDataApi.getImportStatus = async (jobId) => {
      requests += 1
      return job('running', 30)
    }
    let resumed: unknown
    try {
      resumed = await useStore.getState().reconnectUserDataJob()
    } finally {
      userDataApi.getImportStatus = originalGetImportStatus
    }
    expect(requests).toBe(0)
    expect(resumed).toBeNull()
    expect(useStore.getState().userDataJob).toBeNull()
  })
})

