import { useCallback, useEffect, useRef } from 'react'

/** One active pass and only the newest pending pass; no timer or token backlog. */
export class DisplayTaskQueue {
  private active = false
  private pending: (() => Promise<void>) | null = null
  private disposed = false

  schedule<T>(run: () => Promise<T>, commit: (value: T) => void): () => void {
    const task = async () => {
      try {
        const value = await run()
        if (!this.disposed) commit(value)
      } finally {
        this.active = false
        this.pump()
      }
    }
    this.pending = task
    this.pump()
    // Changing content cancels queued work, but lets an active pass finish.
    return () => { if (this.pending === task) this.pending = null }
  }

  private pump(): void {
    if (this.disposed || this.active || !this.pending) return
    const task = this.pending
    this.pending = null
    this.active = true
    void task().catch((error) => console.error('[display] resolution failed', error))
  }

  dispose(): void {
    this.disposed = true
    this.pending = null
  }
}

/**
 * Accept completed streaming prefixes, even when the next token has arrived.
 * Rewrites, context invalidations, new streams and unmounts reject old work.
 */
export function useDisplayTask(version: unknown, source: string, isStreaming: boolean) {
  const latest = useRef({ version, source, isStreaming, epoch: 0 })
  const epoch = latest.current.epoch + (
    version !== latest.current.version || (!latest.current.isStreaming && isStreaming) ? 1 : 0
  )
  latest.current = { version, source, isStreaming, epoch }

  const queueRef = useRef(new DisplayTaskQueue())
  useEffect(() => {
    // Effect replay in StrictMode needs a fresh queue after cleanup.
    const queue = new DisplayTaskQueue()
    queueRef.current = queue
    return () => queue.dispose()
  }, [epoch])

  return useCallback(<T,>(run: () => Promise<T>, commit: (value: T) => void) => {
    const request = latest.current
    return queueRef.current.schedule(run, (value) => {
      const current = latest.current
      if (request.epoch !== current.epoch || request.version !== current.version) return
      if (
        request.source !== current.source
        && !(request.isStreaming && current.source.startsWith(request.source))
      ) return
      commit(value)
    })
  }, [queueRef])
}
