import { useStore } from '@/store'

/**
 * Module-level handle to the active service worker registration. Held outside
 * React so the connection-lost overlay can ask the SW to check for a new
 * bundle the moment the WebSocket reconnects.
 *
 * In dev mode (vite dev) or environments where service workers aren't
 * supported, `registration` stays null and all operations no-op gracefully.
 */
let registration: ServiceWorkerRegistration | null = null

/** Called once from main.tsx with the registration returned by vite-plugin-pwa. */
export function rememberRegistration(reg: ServiceWorkerRegistration | undefined): void {
  if (!reg) return
  registration = reg

  // Watch for a new SW being installed. vite-plugin-pwa's autoUpdate mode will
  // immediately skip-waiting the new worker; we just need to flip the store
  // flag so the connection-lost overlay can switch to "Updating…" copy and
  // stay mounted until the controllerchange listener in main.tsx reloads.
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing
    if (!installing) return
    useStore.getState().setWsUpdatePending(true)

    // If the new worker fails to install (e.g. precache fetch fails), clear
    // the flag so the user isn't stuck behind a spinner that never resolves.
    // The success path runs through controllerchange in main.tsx, which
    // reloads the page and wipes React state anyway.
    installing.addEventListener('statechange', () => {
      if (installing.state === 'redundant') {
        useStore.getState().setWsUpdatePending(false)
      }
    })
  })
}

/**
 * Ask the service worker to check for a new bundle right now (vs. waiting for
 * the hourly poll set up in main.tsx). If a new worker is found, the
 * registration's `updatefound` event will fire and flip `wsUpdatePending`.
 *
 * Returns silently if no registration is available (dev mode, unsupported
 * browser) or if the network request fails — this is best-effort.
 */
export async function checkForBundleUpdate(): Promise<void> {
  if (!registration) return
  try {
    await registration.update()
  } catch {
    // Network glitch checking for the SW update — ignore. The hourly poll and
    // the next reconnect will both retry.
  }
}
