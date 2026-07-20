import { useStore } from '@/store'
import { isServiceWorkerReplacement } from './swUpdatePolicy'

/**
 * Watches the active service worker outside React so the connection-lost
 * overlay can report that a real bundle update is being installed.
 *
 * Update checks are deliberately not coupled to WebSocket reconnects: a flaky
 * connection must never turn into a full-page reload. main.tsx performs the
 * normal launch registration and low-frequency periodic update check.
 */
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

  // Watch for a new SW being installed. vite-plugin-pwa's autoUpdate mode will
  // immediately skip-waiting the new worker; we just need to flip the store
  // flag so the connection-lost overlay can switch to "Updating…" copy and
  // stay mounted until vite-plugin-pwa's onNeedReload callback reloads.
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing
    if (!installing) return
    // A first-time service-worker install also emits updatefound. It is not an
    // application update and must not put a freshly loaded page behind the
    // blocking update overlay.
    if (!isServiceWorkerReplacement(
      Boolean(reg.active),
      Boolean(navigator.serviceWorker.controller),
    )) return
    setBundleUpdatePending(true)

    // If the new worker fails to install (e.g. precache fetch fails), clear
    // the flag so the user isn't stuck behind a spinner that never resolves.
    // The success path runs through onNeedReload in main.tsx, which
    // reloads the page and wipes React state anyway.
    installing.addEventListener('statechange', () => {
      if (installing.state === 'redundant') {
        setBundleUpdatePending(false)
      } else if (installing.state === 'activated') {
        // onNeedReload normally reloads immediately. Clear the blocking UI
        // as a fallback for browsers that activate without dispatching it.
        useStore.getState().setWsUpdatePending(false)
      }
    })
  })
}
