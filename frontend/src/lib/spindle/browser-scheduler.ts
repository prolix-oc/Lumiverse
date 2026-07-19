interface IdleDeadlineLike {
  readonly didTimeout?: boolean
  timeRemaining(): number
}

type SchedulerPhase = 'paint' | 'idle'

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number }
  ) => number
  cancelIdleCallback?: (id: number) => void
}

interface ScheduledTask {
  cancelled: boolean
  phase: SchedulerPhase
  run: () => void
}

const DEFAULT_YIELD_TIMEOUT_MS = 16
const DOM_TASK_TIMEOUT_MS = 120
const DOM_TASK_BUDGET_MS = 6
const PAINT_TASK_BUDGET_MS = 8

const paintTaskQueue: ScheduledTask[] = []
const idleTaskQueue: ScheduledTask[] = []
let scheduledIdlePumpId: number | null = null
let scheduledIdlePumpUsesIdleCallback = false
let scheduledPaintPumpId: number | null = null

function getIdleWindow(): IdleWindow | null {
  if (typeof window === 'undefined') return null
  return window as IdleWindow
}

export function yieldToBrowser(options?: { when?: SchedulerPhase; timeoutMs?: number }): Promise<void> {
  const when = options?.when ?? 'paint'
  const timeoutMs = Math.max(0, options?.timeoutMs ?? DEFAULT_YIELD_TIMEOUT_MS)

  if (typeof window === 'undefined') return Promise.resolve()

  if (when === 'paint') {
    return new Promise((resolve) => {
      let settled = false
      let frameId: number | null = null
      let fallbackId: ReturnType<typeof setTimeout> | null = null
      const finish = () => {
        if (settled) return
        settled = true
        if (frameId != null) window.cancelAnimationFrame(frameId)
        if (fallbackId != null) globalThis.clearTimeout(fallbackId)
        resolve()
      }

      frameId = window.requestAnimationFrame(finish)
      if (!settled) fallbackId = globalThis.setTimeout(finish, timeoutMs)
    })
  }

  const idleWindow = getIdleWindow()
  if (!idleWindow) return Promise.resolve()
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      idleWindow.requestIdleCallback!(() => resolve(), { timeout: timeoutMs })
    })
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, timeoutMs)
  })
}

export function scheduleSpindleDomTask(
  run: () => void,
  options?: { phase?: SchedulerPhase }
): () => void {
  const task: ScheduledTask = {
    cancelled: false,
    phase: options?.phase ?? 'idle',
    run,
  }

  if (task.phase === 'paint') {
    paintTaskQueue.push(task)
    requestPaintTaskPump()
  } else {
    idleTaskQueue.push(task)
    requestIdleTaskPump()
  }

  return () => {
    task.cancelled = true
  }
}

function requestPaintTaskPump(): void {
  if (scheduledPaintPumpId != null || typeof window === 'undefined') return
  scheduledPaintPumpId = window.requestAnimationFrame(() => {
    scheduledPaintPumpId = null
    processTaskQueue(paintTaskQueue, PAINT_TASK_BUDGET_MS)
    if (paintTaskQueue.length > 0) {
      requestPaintTaskPump()
    }
  })
}

function requestIdleTaskPump(): void {
  if (scheduledIdlePumpId != null) return

  const idleWindow = getIdleWindow()
  if (idleWindow && typeof idleWindow.requestIdleCallback === 'function') {
    scheduledIdlePumpUsesIdleCallback = true
    scheduledIdlePumpId = idleWindow.requestIdleCallback(processIdleTaskQueue, {
      timeout: DOM_TASK_TIMEOUT_MS,
    })
    return
  }

  scheduledIdlePumpUsesIdleCallback = false
  scheduledIdlePumpId = window.setTimeout(() => {
    processIdleTaskQueue()
  }, DEFAULT_YIELD_TIMEOUT_MS)
}

function clearScheduledIdlePump(): void {
  if (scheduledIdlePumpId == null) return

  const idleWindow = getIdleWindow()
  if (scheduledIdlePumpUsesIdleCallback && idleWindow && typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(scheduledIdlePumpId)
  } else {
    window.clearTimeout(scheduledIdlePumpId)
  }

  scheduledIdlePumpId = null
}

function processIdleTaskQueue(deadline?: IdleDeadlineLike): void {
  clearScheduledIdlePump()

  if (idleTaskQueue.length === 0) return

  let budgetMs = DOM_TASK_BUDGET_MS
  if (deadline) {
    const remaining = Math.floor(deadline.timeRemaining())
    if (!deadline.didTimeout && remaining <= 0) {
      requestIdleTaskPump()
      return
    }
    budgetMs = deadline.didTimeout
      ? DOM_TASK_BUDGET_MS
      : Math.max(1, Math.min(DOM_TASK_BUDGET_MS, remaining))
  }

  processTaskQueue(idleTaskQueue, budgetMs)

  if (idleTaskQueue.length > 0) {
    requestIdleTaskPump()
  }
}

function processTaskQueue(queue: ScheduledTask[], budgetMs: number): void {
  if (queue.length === 0) return

  const stopAt = performance.now() + budgetMs
  while (queue.length > 0 && performance.now() < stopAt) {
    const task = queue.shift()
    if (!task || task.cancelled) continue

    try {
      task.run()
    } catch (err) {
      console.error('[Spindle] Deferred DOM task failed:', err)
    }
  }
}
