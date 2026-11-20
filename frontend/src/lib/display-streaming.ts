const STREAMING_MACRO_OPENERS = ['{{', '<user>', '<char>', '<bot>'] as const

/**
 * Whether a newer append-only streaming value can paint its raw suffix while
 * the coalesced display preprocess is pending. Potential macro openers are
 * held from their first character so raw syntax never flashes or rewinds.
 */
export function canOptimisticallyAppendStreamingText(previous: string, next: string): boolean {
  if (next.length <= previous.length || !next.startsWith(previous)) return false

  const maxOpenerLength = Math.max(...STREAMING_MACRO_OPENERS.map((opener) => opener.length))
  const scanStart = Math.max(0, previous.length - maxOpenerLength + 1)
  const boundary = next.slice(scanStart).toLowerCase()
  const oldBoundaryLength = previous.length - scanStart

  for (const opener of STREAMING_MACRO_OPENERS) {
    let index = boundary.indexOf(opener)
    while (index !== -1) {
      if (index + opener.length > oldBoundaryLength) return false
      index = boundary.indexOf(opener, index + 1)
    }

    for (let length = 1; length < opener.length; length++) {
      const prefix = opener.slice(0, length)
      if (boundary.endsWith(prefix) && boundary.length > oldBoundaryLength) return false
    }
  }

  return true
}
