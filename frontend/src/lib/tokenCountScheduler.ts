export type TokenCountPriority = 'interactive' | 'adjacent' | 'sweep'

export const DEFAULT_MAX_CONCURRENT = 2
export const DEFAULT_ACTIVITY_PAUSE_MS = 500

export interface TokenCountRequest {
  entryId: string
  cacheKey: string
  model: string
  content: string
  priority: TokenCountPriority
}

export interface TokenCountResult {
  count: number
  approximate: boolean
}

export interface TokenCountSchedulerConsumer {
  entryId: string
  cacheKey: string
}

export interface TokenCountSchedulerDependencies {
  run(request: TokenCountRequest, signal: AbortSignal): Promise<TokenCountResult>
  onResult(request: TokenCountRequest, result: TokenCountResult, consumer: TokenCountSchedulerConsumer): void
  onError(request: TokenCountRequest, error: unknown, consumer: TokenCountSchedulerConsumer): void
  yieldControl(): Promise<void>
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  now(): number
}

export interface TokenCountSchedulerOptions {
  maxConcurrent?: number
  activityPauseMs?: number
}

export interface TokenCountScheduleHandle {
  cancel(): void
}

export interface TokenCountScheduler {
  schedule(request: TokenCountRequest): TokenCountScheduleHandle
  invalidateEntry(entryId: string): void
  notifyActivity(): void
  setPaused(paused: boolean): void
  pumpSweep(): void
  abortAll(): void
  dispose(): void
}

type QueueName = Exclude<TokenCountPriority, 'sweep'>
type TaskState = 'queued' | 'running' | 'settled'

interface Consumer extends TokenCountSchedulerConsumer {
  globalGeneration: number
  cancelled: boolean
}

interface Task {
  request: TokenCountRequest | null
  priority: TokenCountPriority
  state: TaskState
  controller: AbortController | null
  consumers: Set<Consumer>
}

const QUEUE_NAMES: readonly QueueName[] = ['interactive', 'adjacent']

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError'
  }
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

export function createTokenCountScheduler(
  dependencies: TokenCountSchedulerDependencies,
  options: TokenCountSchedulerOptions = {},
): TokenCountScheduler {
  const configuredMaxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const configuredActivityPauseMs = options.activityPauseMs ?? DEFAULT_ACTIVITY_PAUSE_MS
  const maxConcurrent = Number.isFinite(configuredMaxConcurrent)
    ? Math.min(DEFAULT_MAX_CONCURRENT, Math.max(1, Math.floor(configuredMaxConcurrent)))
    : DEFAULT_MAX_CONCURRENT
  const activityPauseMs = Number.isFinite(configuredActivityPauseMs)
    ? Math.max(0, configuredActivityPauseMs)
    : DEFAULT_ACTIVITY_PAUSE_MS
  const queues: Record<QueueName, Task[]> = {
    interactive: [],
    adjacent: [],
  }
  const sweepQueue: Task[] = []
  const tasksByKey = new Map<string, Task>()

  let activeRuns = 0
  let activityUntil = 0
  let activityTimer: ReturnType<typeof setTimeout> | null = null
  let globalGeneration = 0
  let paused = false
  let disposed = false
  let sweepPermits = 0
  let pendingYields = 0

  function isCurrent(consumer: Consumer): boolean {
    return !consumer.cancelled
      && consumer.globalGeneration === globalGeneration
  }

  function removeFromQueue(task: Task): void {
    const queue = task.priority === 'sweep' ? sweepQueue : queues[task.priority]
    const index = queue.indexOf(task)
    if (index >= 0) queue.splice(index, 1)
  }

  function releaseTask(task: Task): void {
    if (task.state === 'queued') removeFromQueue(task)
    task.state = 'settled'
    if (task.request) tasksByKey.delete(task.request.cacheKey)
    task.controller = null
    task.request = null
    task.consumers.clear()
  }

  function cancelConsumer(task: Task, consumer: Consumer): void {
    if (consumer.cancelled) return
    consumer.cancelled = true
    task.consumers.delete(consumer)
    if (task.consumers.size > 0) return

    if (task.state === 'queued') {
      releaseTask(task)
    } else if (task.state === 'running') {
      task.controller?.abort()
      releaseTask(task)
    }
  }

  function promote(task: Task, priority: TokenCountPriority): void {
    if (task.state !== 'queued' || task.priority === priority) return
    const rank = (value: TokenCountPriority): number => value === 'interactive' ? 0 : value === 'adjacent' ? 1 : 2
    if (rank(priority) >= rank(task.priority)) return
    removeFromQueue(task)
    task.priority = priority
    if (priority === 'sweep') {
      sweepQueue.push(task)
    } else {
      queues[priority].push(task)
    }
  }

  function isParked(priority: TokenCountPriority): boolean {
    return priority !== 'interactive' && dependencies.now() < activityUntil
  }

  function takeNextTask(): Task | null {
    for (const priority of QUEUE_NAMES) {
      const queue = queues[priority]
      if (queue.length === 0 || isParked(priority)) continue
      return queue.shift() ?? null
    }

    if (sweepPermits <= 0 || sweepQueue.length === 0 || isParked('sweep')) return null
    sweepPermits -= 1
    return sweepQueue.shift() ?? null
  }

  function deliverResult(task: Task, request: TokenCountRequest, result: TokenCountResult): void {
    for (const consumer of task.consumers) {
      if (!isCurrent(consumer)) continue
      try {
        dependencies.onResult(request, result, consumer)
      } catch {
        // Consumer callbacks cannot destabilize scheduling or retain task state.
      }
    }
  }

  function deliverError(task: Task, request: TokenCountRequest, error: unknown): void {
    for (const consumer of task.consumers) {
      if (!isCurrent(consumer)) continue
      try {
        dependencies.onError(request, error, consumer)
      } catch {
        // Consumer callbacks cannot destabilize scheduling or retain task state.
      }
    }
  }

  function settleAfterYield(): void {
    pendingYields += 1
    void Promise.resolve()
      .then(() => dependencies.yieldControl())
      .catch(() => undefined)
      .finally(() => {
        pendingYields -= 1
        pump()
      })
  }

  function start(task: Task): void {
    const request = task.request
    if (!request || task.consumers.size === 0 || disposed) {
      releaseTask(task)
      return
    }

    task.state = 'running'
    task.controller = new AbortController()
    activeRuns += 1
    const controller = task.controller

    void Promise.resolve()
      .then(() => dependencies.run(request, controller.signal))
      .then((result) => {
        if (!controller.signal.aborted && !disposed && task.request === request) {
          deliverResult(task, request, result)
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error) && !disposed && task.request === request) {
          deliverError(task, request, error)
        }
      })
      .finally(() => {
        activeRuns -= 1
        if (task.request === request) releaseTask(task)
        settleAfterYield()
      })
  }

  function pump(): void {
    if (disposed || paused || pendingYields > 0) return
    while (activeRuns < maxConcurrent) {
      const task = takeNextTask()
      if (!task) return
      start(task)
    }
  }

  function clearActivityTimer(): void {
    if (activityTimer == null) return
    dependencies.clearTimeout(activityTimer)
    activityTimer = null
  }

  function abortAllTasks(): void {
    globalGeneration += 1
    clearActivityTimer()
    activityUntil = 0
    sweepPermits = 0
    for (const task of [...tasksByKey.values()]) {
      task.controller?.abort()
      releaseTask(task)
    }
  }

  return {
    schedule(request: TokenCountRequest): TokenCountScheduleHandle {
      if (disposed) throw new Error('TOKEN_SCHEDULER_DISPOSED')

      const consumer: Consumer = {
        entryId: request.entryId,
        cacheKey: request.cacheKey,
        globalGeneration,
        cancelled: false,
      }
      const existing = tasksByKey.get(request.cacheKey)
      if (existing) {
        existing.consumers.add(consumer)
        promote(existing, request.priority)
        pump()
        return { cancel: () => cancelConsumer(existing, consumer) }
      }

      const task: Task = {
        request,
        priority: request.priority,
        state: 'queued',
        controller: null,
        consumers: new Set([consumer]),
      }
      tasksByKey.set(request.cacheKey, task)
      if (request.priority === 'sweep') {
        sweepQueue.push(task)
      } else {
        queues[request.priority].push(task)
      }
      pump()
      return { cancel: () => cancelConsumer(task, consumer) }
    },

    invalidateEntry(entryId: string): void {
      for (const task of [...tasksByKey.values()]) {
        for (const consumer of [...task.consumers]) {
          if (consumer.entryId === entryId) cancelConsumer(task, consumer)
        }
      }
      pump()
    },

    notifyActivity(): void {
      if (disposed) return
      activityUntil = dependencies.now() + activityPauseMs
      clearActivityTimer()
      activityTimer = dependencies.setTimeout(() => {
        activityTimer = null
        pump()
      }, activityPauseMs)
      pump()
    },

    setPaused(nextPaused: boolean): void {
      if (disposed) return
      paused = nextPaused
      if (!paused) pump()
    },

    pumpSweep(): void {
      if (disposed || sweepQueue.length === 0) return
      sweepPermits += 1
      pump()
    },

    abortAll(): void {
      abortAllTasks()
    },

    dispose(): void {
      if (disposed) return
      abortAllTasks()
      disposed = true
      queues.interactive.length = 0
      queues.adjacent.length = 0
      sweepQueue.length = 0
      tasksByKey.clear()
    }
  }
}
