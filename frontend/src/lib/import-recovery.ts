import { useStore } from '@/store'
import { userDataApi } from '@/api/user-data'

const listeners = new Set<() => void>()
const memoryJobs = new Map<string, string>()
const storageKey = (userId: string) => `lumiverse:pending-import:${userId}`

export function pendingImportJob(userId: string): string | null {
  try { return localStorage.getItem(storageKey(userId)) ?? memoryJobs.get(userId) ?? null }
  catch { return memoryJobs.get(userId) ?? null }
}

/** Keep tracking outside the settings panel, including across a page restart. */
export function trackImportJob(userId: string, jobId: string): void {
  if (!jobId) return
  if (pendingImportJob(userId) === jobId) return
  memoryJobs.set(userId, jobId)
  try { localStorage.setItem(storageKey(userId), jobId) } catch { /* Storage can be unavailable. */ }
  for (const listener of listeners) listener()
}

export function forgetImportJob(userId: string, jobId: string): void {
  if (memoryJobs.get(userId) === jobId) memoryJobs.delete(userId)
  try {
    if (pendingImportJob(userId) === jobId) localStorage.removeItem(storageKey(userId))
  } catch { /* Storage can be unavailable. */ }
}

/** Poll only the importing account's known job; recover missed completion events. */
export function watchImportJob(userId: string, refresh: (jobId: string) => Promise<void>): () => void {
  let stopped = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const current = () => !stopped && useStore.getState().isAuthenticated && useStore.getState().user?.id === userId
  // The Android restore notification reconnects to the local server first.
  // Open its controls after authentication, including after a process restart.
  const location = new URL(window.location.href)
  if (current() && location.searchParams.get('restoreImport') === '1') {
    location.searchParams.delete('restoreImport')
    window.history.replaceState(window.history.state, '', location)
    useStore.getState().openSettings('dataPortability')
  }
  const poll = async () => {
    if (polling || !current()) return
    clearTimeout(timer)
    let jobId = pendingImportJob(userId)
    polling = true
    try {
      // A restarted Android backend can have a new origin and no localStorage.
      if (!jobId) {
        const { jobs } = await userDataApi.getImportJobs()
        if (!current()) return
        jobId = pendingImportJob(userId) ?? jobs[0]?.jobId
        if (!jobId) return
        trackImportJob(userId, jobId)
      }
      const job = await userDataApi.getImportStatus(jobId)
      if (!current() || pendingImportJob(userId) !== jobId) return
      if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
        // Imports commit batches. Even a cancelled job may have restored rows.
        await refresh(jobId)
        if (current()) forgetImportJob(userId, jobId)
      }
    } catch (error) {
      // A backend restart discards in-memory jobs but can retain committed
      // batches. Refresh those too, then stop tracking the vanished job.
      if (current() && (error as { status?: number }).status === 404) {
        try {
          await refresh(jobId)
          if (current()) forgetImportJob(userId, jobId)
        } catch { /* Retry a failed refresh on the next poll. */ }
      }
    } finally {
      polling = false
      if (current() && pendingImportJob(userId)) timer = setTimeout(poll, 2000)
    }
  }
  const wake = () => { void poll() }
  listeners.add(wake)
  window.addEventListener('online', wake)
  window.addEventListener('storage', wake)
  document.addEventListener('visibilitychange', wake)
  wake()
  return () => {
    stopped = true
    clearTimeout(timer)
    listeners.delete(wake)
    window.removeEventListener('online', wake)
    window.removeEventListener('storage', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}
