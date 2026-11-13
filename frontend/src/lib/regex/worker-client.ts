import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'

export { DISPLAY_SLOW_REGEX_WARNING_MS as WARN_MS } from './compiler'

export const KILL_MS_DEFAULT = 250
export const DEADLINE_GRACE_MS = 50
export const CONGESTED_DEADLINE_GRACE_MS = 1_000
export const SCHEDULER_STARVATION_MS = 200
export const COLD_SPAWN_KILL_MS = 5_000

function resolveKillMs(): number {
  const raw = import.meta.env.VITE_REGEX_KILL_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILL_MS_DEFAULT
}

export const KILL_MS = resolveKillMs()

export interface RegexWorkerLike {
  postMessage(message: ApplyWorkerJob): void
  terminate(): void
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void
  setErrorHandler(handler: (error: Error) => void): void
}

export interface RegexWorkerDeps {
  now(): number
  spawnWorker(): RegexWorkerLike
  scheduleTimer(fn: () => void, ms: number): () => void
  isSupported(): boolean
  isPageVisible(): boolean
  schedulerLagMs(): number
}

export interface RegexWorkerCallbacks {
  onScriptFlagged?: (event: { jobId: number; scriptId?: string; scriptName?: string; elapsedMs?: number }) => void
}

export class RegexWorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexWorkerError'
  }
}

export class RegexWorkerTimeoutError extends RegexWorkerError {
  readonly jobId: number
  readonly scriptId?: string
  readonly scriptName?: string
  readonly scriptIndex?: number
  readonly completedScriptCount: number
  readonly checkpointResult: string
  readonly phase: 'dispatch' | 'execution'
  readonly wallElapsedMs: number
  readonly schedulerLagMs: number
  readonly pageVisible: boolean
  readonly environmentCongested: boolean

  constructor(
    jobId: number,
    script: { scriptId?: string; scriptName?: string; scriptIndex?: number } | undefined,
    checkpoint: { completedScriptCount: number; result: string },
    diagnostics: {
      phase: 'dispatch' | 'execution'
      wallElapsedMs: number
      schedulerLagMs: number
      pageVisible: boolean
      environmentCongested: boolean
    },
    message?: string,
  ) {
    const label = script?.scriptId ?? 'unknown'
    super(message ?? `regex job ${jobId} exceeded ${KILL_MS}ms deadline (script ${label})`)
    this.name = 'RegexWorkerTimeoutError'
    this.jobId = jobId
    this.scriptId = script?.scriptId
    this.scriptName = script?.scriptName
    this.scriptIndex = script?.scriptIndex
    this.completedScriptCount = checkpoint.completedScriptCount
    this.checkpointResult = checkpoint.result
    this.phase = diagnostics.phase
    this.wallElapsedMs = diagnostics.wallElapsedMs
    this.schedulerLagMs = diagnostics.schedulerLagMs
    this.pageVisible = diagnostics.pageVisible
    this.environmentCongested = diagnostics.environmentCongested
  }
}

export class RegexJobSupersededError extends RegexWorkerError {
  readonly jobId: number
  constructor(jobId: number, message = `regex job ${jobId} superseded by a newer job for the same message`) {
    super(message)
    this.name = 'RegexJobSupersededError'
    this.jobId = jobId
  }
}

export class RegexWorkerUnsupportedError extends RegexWorkerError {
  constructor(message = 'Worker is not supported in this environment') {
    super(message)
    this.name = 'RegexWorkerUnsupportedError'
  }
}

export class RegexWorkerCrashedError extends RegexWorkerError {
  constructor(message = 'regex worker crashed') {
    super(message)
    this.name = 'RegexWorkerCrashedError'
  }
}

function defaultSpawnWorker(): RegexWorkerLike {
  const worker = new Worker(new URL('./apply.worker.ts', import.meta.url), {
    type: 'module',
    name: 'lumiverse-regex-apply',
  })
  let messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  let errorHandler: ((error: Error) => void) | null = null
  worker.onmessage = (event: MessageEvent<ApplyWorkerResponse>) => messageHandler?.(event.data)
  worker.onerror = (event) => errorHandler?.(new Error(event.message || 'worker error'))
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    setMessageHandler: (handler) => { messageHandler = handler },
    setErrorHandler: (handler) => { errorHandler = handler },
  }
}

let deps: RegexWorkerDeps | null = null
let callbacks: RegexWorkerCallbacks = {}
let schedulerCanary: Worker | null = null
let schedulerCanaryFailed = false
let schedulerCanaryLastBeatAt = 0
let schedulerCanaryIdleTimer: ReturnType<typeof setTimeout> | null = null

function stopSchedulerCanary(): void {
  schedulerCanary?.terminate()
  schedulerCanary = null
  schedulerCanaryLastBeatAt = 0
  if (schedulerCanaryIdleTimer !== null) clearTimeout(schedulerCanaryIdleTimer)
  schedulerCanaryIdleTimer = null
}

function deferSchedulerCanaryStop(): void {
  if (schedulerCanaryIdleTimer !== null) clearTimeout(schedulerCanaryIdleTimer)
  schedulerCanaryIdleTimer = setTimeout(stopSchedulerCanary, 30_000)
}

function defaultSchedulerLagMs(): number {
  if (!schedulerCanary && !schedulerCanaryFailed && typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./scheduler-canary.worker.ts', import.meta.url), {
        type: 'module',
        name: 'lumiverse-regex-scheduler-canary',
      })
      worker.onmessage = () => { schedulerCanaryLastBeatAt = Date.now() }
      worker.onerror = () => {
        if (schedulerCanary === worker) schedulerCanary = null
        schedulerCanaryFailed = true
      }
      schedulerCanary = worker
      deferSchedulerCanaryStop()
    } catch {
      schedulerCanaryFailed = true
    }
  }
  return schedulerCanaryLastBeatAt > 0
    ? Math.max(0, Date.now() - schedulerCanaryLastBeatAt)
    : Number.POSITIVE_INFINITY
}

function getDeps(): RegexWorkerDeps {
  if (!deps) {
    deps = {
      now: () => Date.now(),
      spawnWorker: defaultSpawnWorker,
      scheduleTimer: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
      isSupported: () => typeof Worker !== 'undefined',
      isPageVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      schedulerLagMs: defaultSchedulerLagMs,
    }
  }
  return deps
}

export function setRegexWorkerDepsForTests(overrides: Partial<RegexWorkerDeps>): void {
  deps = { ...getDeps(), ...overrides }
}

export function setRegexWorkerCallbacks(next: RegexWorkerCallbacks): void {
  callbacks = next
}

export type RegexJobInput = Omit<ApplyWorkerJob, 'jobId'> & {
  dedupeKey?: string
  dedupeGeneration?: number
}
export type RegexJobOutcome = {
  op: 'apply'
  result: string
  elapsedMs: number
  scriptElapsedMs: number[]
}

interface PendingJob {
  job: ApplyWorkerJob
  dedupeKey?: string
  dedupeGeneration?: number
  resolve: (outcome: RegexJobOutcome) => void
  reject: (error: RegexWorkerError) => void
  cancelDeadline: (() => void) | null
  currentScript: { scriptId?: string; scriptName?: string; scriptIndex?: number } | null
  completedScriptCount: number
  checkpointResult: string
  phaseStartedAt: number
}

const queue: PendingJob[] = []
let active: PendingJob | null = null
let activeWorker: RegexWorkerLike | null = null
let activeWorkerWarm = false
let nextJobId = 1

export function isSupported(): boolean {
  return getDeps().isSupported()
}

function ensureWorker(): RegexWorkerLike {
  if (activeWorker) return activeWorker
  const worker = getDeps().spawnWorker()
  worker.setMessageHandler((message) => handleWorkerMessage(worker, message))
  worker.setErrorHandler((error) => handleWorkerError(worker, error))
  activeWorker = worker
  activeWorkerWarm = false
  return worker
}

function armDeadline(entry: PendingJob): void {
  entry.cancelDeadline?.()
  entry.phaseStartedAt = getDeps().now()
  entry.cancelDeadline = getDeps().scheduleTimer(
    () => beginDeadlineGrace(entry),
    activeWorkerWarm ? KILL_MS : COLD_SPAWN_KILL_MS,
  )
}

function beginDeadlineGrace(entry: PendingJob): void {
  if (active !== entry) return
  const pageVisible = getDeps().isPageVisible()
  const schedulerLagMs = getDeps().schedulerLagMs()
  const environmentCongested = !pageVisible
    || !Number.isFinite(schedulerLagMs)
    || schedulerLagMs >= SCHEDULER_STARVATION_MS
  entry.cancelDeadline = getDeps().scheduleTimer(
    () => handleDeadlineExpired(entry),
    environmentCongested ? CONGESTED_DEADLINE_GRACE_MS : DEADLINE_GRACE_MS,
  )
}

function pumpQueue(): void {
  if (active || queue.length === 0) return
  const entry = queue.shift()!
  let worker: RegexWorkerLike
  try {
    worker = ensureWorker()
  } catch (error) {
    entry.reject(new RegexWorkerCrashedError(
      `regex worker construction failed: ${error instanceof Error ? error.message : String(error)}`,
    ))
    pumpQueue()
    return
  }
  active = entry
  armDeadline(entry)
  try {
    worker.postMessage(entry.job)
  } catch (error) {
    entry.cancelDeadline?.()
    entry.cancelDeadline = null
    active = null
    activeWorker?.terminate()
    activeWorker = null
    entry.reject(new RegexWorkerCrashedError(
      `regex worker postMessage failed: ${error instanceof Error ? error.message : String(error)}`,
    ))
    pumpQueue()
  }
}

function handleWorkerMessage(worker: RegexWorkerLike, message: ApplyWorkerResponse): void {
  if (worker !== activeWorker) return
  const wasWarm = activeWorkerWarm
  activeWorkerWarm = true
  if (message.type === 'ready') {
    if (active && !wasWarm && !active.currentScript) armDeadline(active)
    return
  }
  if (!active || active.job.jobId !== message.jobId) return
  if (message.type === 'progress') {
    active.currentScript = {
      ...(message.scriptId ? { scriptId: message.scriptId } : {}),
      ...(message.scriptName ? { scriptName: message.scriptName } : {}),
      scriptIndex: message.scriptIndex,
    }
    armDeadline(active)
    return
  }
  if (message.type === 'checkpoint') {
    active.completedScriptCount = message.scriptIndex + 1
    active.checkpointResult = message.result
    return
  }

  const entry = active
  active = null
  entry.cancelDeadline?.()
  entry.cancelDeadline = null
  if (message.type === 'error') {
    callbacks.onScriptFlagged?.({
      jobId: message.jobId,
      ...(entry.currentScript ?? {}),
      elapsedMs: message.elapsedMs,
    })
    entry.reject(new RegexWorkerError(`regex job ${message.jobId} failed: ${message.error}`))
  } else {
    entry.resolve({
      op: 'apply',
      result: message.result,
      elapsedMs: message.elapsedMs,
      scriptElapsedMs: message.scriptElapsedMs,
    })
  }
  pumpQueue()
}

function handleWorkerError(worker: RegexWorkerLike, error: Error): void {
  if (worker !== activeWorker) return
  worker.terminate()
  activeWorker = null
  const entry = active
  active = null
  if (entry) {
    entry.cancelDeadline?.()
    entry.reject(new RegexWorkerCrashedError(`regex worker crashed: ${error.message}`))
  }
  pumpQueue()
}

function handleDeadlineExpired(entry: PendingJob): void {
  if (active !== entry) return
  // Re-sample after the grace window. A canary created at the primary deadline
  // starts with unknown health, but can prove the scheduler healthy while the
  // suspected regex remains wedged.
  const pageVisible = getDeps().isPageVisible()
  const schedulerLagMs = getDeps().schedulerLagMs()
  const diagnostics = {
    pageVisible,
    schedulerLagMs,
    environmentCongested: !pageVisible
      || !Number.isFinite(schedulerLagMs)
      || schedulerLagMs >= SCHEDULER_STARVATION_MS,
  }
  activeWorker?.terminate()
  activeWorker = null
  active = null
  entry.cancelDeadline?.()
  entry.cancelDeadline = null
  entry.reject(new RegexWorkerTimeoutError(
    entry.job.jobId,
    entry.currentScript ?? undefined,
    { completedScriptCount: entry.completedScriptCount, result: entry.checkpointResult },
    {
      phase: entry.currentScript ? 'execution' : 'dispatch',
      wallElapsedMs: Math.max(0, getDeps().now() - entry.phaseStartedAt),
      ...diagnostics,
    },
  ))
  pumpQueue()
}

export function runRegexJobInWorker(input: RegexJobInput): Promise<RegexJobOutcome> {
  if (!isSupported()) return Promise.reject(new RegexWorkerUnsupportedError())

  const { dedupeKey, dedupeGeneration, ...jobFields } = input
  const job: ApplyWorkerJob = { ...jobFields, jobId: nextJobId++ }
  const generation = dedupeGeneration ?? job.jobId
  return new Promise<RegexJobOutcome>((resolve, reject) => {
    if (dedupeKey !== undefined) {
      const generationOf = (entry: PendingJob): number => entry.dedupeGeneration ?? entry.job.jobId
      const fresherExists = (active?.dedupeKey === dedupeKey && generationOf(active) > generation)
        || queue.some((entry) => entry.dedupeKey === dedupeKey && generationOf(entry) > generation)
      if (fresherExists) {
        reject(new RegexJobSupersededError(job.jobId))
        return
      }
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const stale = queue[index]!
        if (stale.dedupeKey !== dedupeKey || generationOf(stale) >= generation) continue
        queue.splice(index, 1)
        stale.reject(new RegexJobSupersededError(stale.job.jobId))
      }
    }
    queue.push({
      job,
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      ...(dedupeGeneration !== undefined ? { dedupeGeneration } : {}),
      resolve,
      reject,
      cancelDeadline: null,
      // No script is blamed until the worker has actually acknowledged that it
      // started one. A dispatch timeout can simply be worker starvation.
      currentScript: null,
      completedScriptCount: 0,
      checkpointResult: job.body,
      phaseStartedAt: 0,
    })
    pumpQueue()
  })
}

export function resetRegexWorkerForTests(): void {
  deps = null
  callbacks = {}
  active?.cancelDeadline?.()
  active = null
  queue.length = 0
  activeWorker?.terminate()
  activeWorker = null
  activeWorkerWarm = false
  stopSchedulerCanary()
  schedulerCanaryFailed = false
  nextJobId = 1
}
