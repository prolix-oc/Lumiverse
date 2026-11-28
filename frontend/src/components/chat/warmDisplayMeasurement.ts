/** Keep a previously measured row out of the size model while its edited
 * display is reconstructed. Pending HTML is still invalidated normally.
 * The quiet window is bounded so a genuinely shorter edit cannot reserve
 * stale geometry forever. Only warm, unpinned rows are enrolled by the list.
 */
const QUIET_MS = 180
const MAX_SETTLE_MS = 800

interface HeldRow {
  height: number
  readyAt: number | null
  lastHeight: number | null
  timer: ReturnType<typeof setTimeout> | null
}

export function createWarmDisplayMeasurementQueue(
  commit: (row: HTMLElement) => void,
) {
  // Pending rows may be virtualized away before display resolves. Do not
  // retain their DOM or wait for a ready event that can never arrive.
  let held = new WeakMap<HTMLElement, HeldRow>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  function cancel(state: HeldRow) {
    if (state.timer === null) return
    clearTimeout(state.timer)
    timers.delete(state.timer)
    state.timer = null
  }
  function remove(row: HTMLElement) {
    const state = held.get(row)
    if (state) cancel(state)
    held.delete(row)
  }
  function schedule(row: HTMLElement, state: HeldRow) {
    if (state.readyAt === null) return
    cancel(state)
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (held.get(row) !== state || state.timer !== timer) return
      state.timer = null
      if (!row.isConnected) { remove(row); return }
      if (row.querySelector('[data-display-pending]')) {
        state.readyAt = null
        return
      }
      const height = row.offsetHeight
      if (height !== state.lastHeight && state.readyAt !== null
        && performance.now() - state.readyAt < MAX_SETTLE_MS) {
        state.lastHeight = height
        schedule(row, state)
        return
      }
      remove(row)
      commit(row)
    }, Math.max(0, Math.min(QUIET_MS, MAX_SETTLE_MS - (performance.now() - state.readyAt))))
    state.timer = timer
    timers.add(timer)
  }
  function startSettling(row: HTMLElement, state: HeldRow) {
    if (state.readyAt !== null) return
    state.readyAt = performance.now()
    state.lastHeight = row.offsetHeight
    schedule(row, state)
  }
  return {
    begin(row: HTMLElement, height: number) {
      const previous = held.get(row)
      if (previous) cancel(previous)
      held.set(row, { height: previous?.height ?? height, readyAt: null, lastHeight: null, timer: null })
    },
    ready(row: HTMLElement) {
      const state = held.get(row)
      if (!state) return false
      startSettling(row, state)
      return true
    },
    measure(row: HTMLElement): number | undefined {
      const state = held.get(row)
      if (!state) return undefined
      if (!row.querySelector('[data-display-pending]')) {
        // Regeneration can take ownership before a pending display completes.
        // Streaming removes the marker without dispatching displayReady, so
        // observing completed DOM must also start the bounded release window.
        startSettling(row, state)
        const height = row.offsetHeight
        if (height !== state.lastHeight) {
          state.lastHeight = height
          schedule(row, state)
        }
      }
      return state.height
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      held = new WeakMap()
    },
  }
}
