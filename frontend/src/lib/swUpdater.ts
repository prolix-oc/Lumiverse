import { useStore } from '@/store'
import { isServiceWorkerReplacement } from './swUpdatePolicy'

/**
 * Holds the active service-worker registration outside React so a recovered
 * server connection can immediately check whether its frontend bundle changed.
 *
 * The reconnect path only reaches this after a previously healthy connection
 * has completed a new authenticated ping/pong round trip. That avoids update
 * checks during initial load or while a transient connection is still down.
 */
let registration: ServiceWorkerRegistration | null = null
let checkRequested = false
let updateCheck: Promise<void> | null = null
const observedRegistrations = new WeakSet<ServiceWorkerRegistration>()
const observedWorkers = new WeakSet<ServiceWorker>()
let updateUiTimeout: ReturnType<typeof setTimeout> | null = null
const UPDATE_UI_TIMEOUT_MS = 45_000

function setBundleUpdatePending(pending: boolean): void {
  useStore.getState().setWsUpdatePending(pending)
  if (updateUiTimeout) {
    clearTimeout(updateUiTimeout)
    updateUiTimeout = null
  }
  if (pending) {
    updateUiTimeout = setTimeout(() => {
      useStore.getState().setWsUpdatePending(false)
      updateUiTimeout = null
    }, UPDATE_UI_TIMEOUT_MS)
  }
}

/** Called once from main.tsx with the registration returned by vite-plugin-pwa. */
export function rememberRegistration(reg: ServiceWorkerRegistration | undefined): void {
  if (!reg) return
  registration = reg

  // Registration can resolve after updatefound, with a worker already installing.
  const watchInstalling = () => {
    const installing = reg.installing
    if (!installing || observedWorkers.has(installing)) return
    observedWorkers.add(installing)
    // A first-time service-worker install also emits updatefound. It is not an
    // application update and must not put a freshly loaded page behind the
    // blocking update overlay.
    if (!isServiceWorkerReplacement(
      Boolean(reg.active),
      Boolean(navigator.serviceWorker?.controller),
    )) return
    setBundleUpdatePending(true)

    // If the new worker fails to install (e.g. precache fetch fails), clear
    // the flag so the user isn't stuck behind a spinner that never resolves.
    // A controller change reloads the page on success.
    installing.addEventListener('statechange', () => {
      if (installing.state === 'redundant') {
        setBundleUpdatePending(false)
      } else if (installing.state === 'activated') {
        setBundleUpdatePending(false)
      }
    })
  }
  if (!observedRegistrations.has(reg)) {
    observedRegistrations.add(reg)
    reg.addEventListener('updatefound', watchInstalling)
  }
  watchInstalling()
  if (checkRequested) void checkForBundleUpdate()
}

/**
 * Check for a new service worker immediately after a verified server
 * reconnect, foreground resume, or periodic poll.
 */
export function checkForBundleUpdate(): Promise<void> {
  if (!registration) {
    checkRequested = true
    return Promise.resolve()
  }
  checkRequested = false
  if (!updateCheck) {
    updateCheck = registration.update().then(() => {}, () => {
      // A failed best-effort check should not interfere with socket recovery.
    }).finally(() => { updateCheck = null })
  }
  return updateCheck
}
