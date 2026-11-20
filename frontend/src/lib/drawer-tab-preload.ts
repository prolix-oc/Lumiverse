/** Optional warming yields to constrained connections and hidden documents. */
export function canPreloadDrawerTab(): boolean {
  if (typeof window === 'undefined' || document.hidden) return false
  const navigator = window.navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  if (!navigator) return false
  return navigator.onLine !== false && !navigator.connection?.saveData
    && !['slow-2g', '2g'].includes(navigator.connection?.effectiveType ?? '')
}

/** One optional import after the visible drawer settles, cancelled on navigation/close. */
export function scheduleIdleDrawerPreload(preload: () => void): () => void {
  let idleId: number | undefined
  let cancelled = false
  const run = () => { if (!cancelled && canPreloadDrawerTab()) preload() }
  const timer = window.setTimeout(() => {
    if (!canPreloadDrawerTab()) return
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(deadline => {
        if (deadline.timeRemaining() > 5) run()
      }, { timeout: 2000 })
    } else {
      run()
    }
  }, 1000)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
    if (idleId !== undefined) window.cancelIdleCallback?.(idleId)
  }
}
