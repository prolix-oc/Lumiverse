/** Match SQLite's cursor ordering even when display order breaks ties by date. */
export function getHistoryBoundary<T extends { index_in_chat: number; id: string }>(messages: readonly T[]): T | undefined {
  return messages.reduce<T | undefined>((first, message) => !first
    || message.index_in_chat < first.index_in_chat
    || (message.index_in_chat === first.index_in_chat && message.id < first.id) ? message : first, undefined)
}

/** One speculative/foreground page per navigation. Resolved pages remain reusable until consumed. */
export function createHistoryPageLoader<T>() {
  let current: { key: string; abort: AbortController; promise: Promise<T | undefined> } | undefined
  const reset = () => {
    current?.abort.abort()
    current = undefined
  }
  return {
    reset,
    load(key: string, read: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
      if (current?.key === key) return current.promise
      reset()
      const abort = new AbortController()
      const entry = { key, abort, promise: undefined as unknown as Promise<T | undefined> }
      entry.promise = read(abort.signal).then((page) => current === entry ? page : undefined)
        .catch((error) => {
          if (current !== entry || abort.signal.aborted) return undefined
          current = undefined
          throw error
        })
      current = entry
      return entry.promise
    },
  }
}
