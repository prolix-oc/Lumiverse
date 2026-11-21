import { claimServiceWorkerReload, SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS } from './swUpdatePolicy'

/** Reload only after this document's controller changes, including other tabs' updates. */
export function installServiceWorkerReload(
  workers: ServiceWorkerContainer,
  storage: () => Pick<Storage, 'getItem' | 'setItem'>,
  reload: () => void,
): () => void {
  let controller = workers.controller
  let reloading = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    const current = workers.controller
    if (reloading || !current || current === controller) return
    if (!controller) {
      // First install claims a page that already loaded from the network.
      controller = current
      return
    }
    try {
      if (!claimServiceWorkerReload(storage())) {
        // A second real deployment within the guard window must not leave the
        // old JS running indefinitely. Keep the durable loop protection.
        if (!retry) retry = setTimeout(() => { retry = undefined; check() }, SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS)
        return
      }
    } catch { return }
    reloading = true
    if (retry) clearTimeout(retry)
    reload()
  }
  workers.addEventListener('controllerchange', check)
  return check
}
