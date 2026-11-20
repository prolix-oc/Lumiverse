/**
 * `updatefound` fires both for a first install and for a replacement worker.
 * Only a replacement should block the application behind the update overlay.
 */
export function isServiceWorkerReplacement(
  hasActiveWorker: boolean,
  hasController: boolean,
): boolean {
  return hasActiveWorker || hasController
}

export const SERVICE_WORKER_RELOAD_GUARD_KEY = 'lumiverse:sw-reload-at:v1'
export const SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS = 30_000

type ReloadGuardStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Claim the one automatic service-worker reload allowed for this tab within
 * the guard window. Unlike a module variable, sessionStorage survives the
 * reload itself, so a worker lifecycle race cannot start a refresh loop.
 *
 * Fail closed when storage is unavailable: reloading without a durable guard
 * is worse than leaving the newly activated worker to control the current tab
 * until the user navigates or refreshes manually.
 */
export function claimServiceWorkerReload(
  storage: ReloadGuardStorage,
  now = Date.now(),
): boolean {
  try {
    const previous = Number(storage.getItem(SERVICE_WORKER_RELOAD_GUARD_KEY))
    if (
      Number.isFinite(previous)
      && previous > 0
      && Math.abs(now - previous) < SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS
    ) {
      return false
    }

    storage.setItem(SERVICE_WORKER_RELOAD_GUARD_KEY, String(now))
    return true
  } catch {
    return false
  }
}
