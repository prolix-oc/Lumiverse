export const MESSAGE_ROW_MEASURING_ATTRIBUTE = 'data-message-row-measuring'

export function readMessageRowHeight(row: HTMLElement, entry?: ResizeObserverEntry): number {
  // offsetHeight and borderBoxSize use layout pixels, including under UI zoom.
  // getBoundingClientRect would mix zoomed coordinates into the virtualizer.
  return Math.max(1, Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight))
}

export function revealMeasuredMessageRow(row: HTMLElement): void {
  if (!row.querySelector('[data-display-pending]')) row.removeAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)
}

/** Batch cold display completions after React's commit, but before paint. */
export function createMessageRowRevealQueue(
  resize: (row: HTMLElement, height: number) => void,
  batch?: { beforeResize(): void; afterResize(): void },
) {
  const rows = new Set<HTMLElement>()
  let scheduled = false
  let disposed = false
  return {
    schedule(row: HTMLElement) {
      if (disposed) return
      rows.add(row)
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (disposed) return
        const measurements = [...rows]
          .filter(row => row.isConnected && !row.querySelector('[data-display-pending]'))
          .map(row => ({ row, height: readMessageRowHeight(row) }))
        rows.clear()
        if (measurements.length === 0) return
        // Read all sizes before updating positions. resizeItem bypasses the
        // virtualizer's deliberate skip of measureElement during user scroll.
        batch?.beforeResize()
        try {
          for (const { row, height } of measurements) {
            resize(row, height)
            revealMeasuredMessageRow(row)
          }
        } finally {
          batch?.afterResize()
        }
      })
    },
    dispose() { disposed = true; rows.clear() },
  }
}
