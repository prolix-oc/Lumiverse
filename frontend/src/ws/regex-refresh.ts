/** Coalesce per-script WS notifications without changing the extension event contract. */
export function createRegexRefreshScheduler(
  load: (shouldApply: () => boolean) => Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let revision = 0
  let disposed = false

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, 75)
  }

  const refresh = async () => {
    timer = undefined
    if (disposed) return
    inFlight = true
    const startedAt = revision
    try {
      // If another change arrives during pagination, discard that snapshot and
      // fetch again after this request completes. Never run parallel reloads.
      await load(() => !disposed && revision === startedAt)
    } catch {
      // Background synchronization is best-effort; the next event can retry.
    } finally {
      inFlight = false
      if (!disposed && revision !== startedAt) schedule()
    }
  }

  return {
    request: () => {
      if (disposed) return
      revision += 1
      if (!inFlight) schedule()
    },
    dispose: () => {
      disposed = true
      clearTimeout(timer)
    },
  }
}
