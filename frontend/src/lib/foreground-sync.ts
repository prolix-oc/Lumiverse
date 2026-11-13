/** Coalesce resume events and recover failed registration without holding a suspended run open. */
export function createForegroundSync(sync: (signal: AbortSignal) => Promise<void>, pollMs: number | undefined, lifecycle: {
  foreground(): boolean
  subscribe(onState: () => void): () => void
}) {
  let stopped = false, pending = false, retryMs = 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | undefined
  const request = () => {
    if (stopped || !lifecycle.foreground()) return
    if (current) { pending = true; return }
    clearTimeout(timer)
    timer = setTimeout(() => { void run() }, 100)
  }
  const run = async () => {
    if (stopped || current || !lifecycle.foreground()) return
    const controller = new AbortController()
    current = controller
    pending = false
    // A native reply can be lost across suspension. Retire the run as
    // well as aborting HTTP requests, so the next activation is never blocked.
    let onAbort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const deadline = setTimeout(() => controller.abort(new Error('Native registration timed out')), 35_000)
    let failed = false
    try {
      await Promise.race([sync(controller.signal), interrupted])
      retryMs = 1000
    } catch { failed = true }
    finally {
      clearTimeout(deadline)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort()
      current = undefined
      if (!stopped && lifecycle.foreground()) {
        if (pending) request()
        else if (failed) {
          timer = setTimeout(() => { void run() }, retryMs)
          retryMs = Math.min(retryMs * 2, 30_000)
        }
      }
    }
  }
  const onState = () => {
    clearTimeout(timer)
    if (lifecycle.foreground()) {
      retryMs = 1000
      current?.abort()
      request()
    }
    else { pending = false; current?.abort() }
  }
  const unsubscribe = lifecycle.subscribe(onState)
  document.addEventListener('visibilitychange', onState)
  window.addEventListener('online', onState)
  window.addEventListener('pageshow', onState)
  const interval = pollMs ? setInterval(() => { if (!current) request() }, pollMs) : undefined
  request()
  return {
    request,
    stop() {
      stopped = true
      clearTimeout(timer)
      clearInterval(interval)
      current?.abort()
      unsubscribe()
      document.removeEventListener('visibilitychange', onState)
      window.removeEventListener('online', onState)
      window.removeEventListener('pageshow', onState)
    },
  }
}
