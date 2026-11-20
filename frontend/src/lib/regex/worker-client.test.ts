import { describe, expect, mock, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse, ApplyWorkerScript } from './apply.worker'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/store', () => ({ useStore: { getState: () => ({}) } }))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))

import type { RegexWorkerLike } from './worker-client'
const { compileRegex } = await import('./compile-regex')
const { replaceWithinRegexSearchWindow } = await import('./search-window')
const {
  COLD_SPAWN_KILL_MS,
  KILL_MS,
  RegexJobSupersededError,
  RegexWorkerTimeoutError,
  RegexWorkerUnsupportedError,
  resetRegexWorkerForTests,
  runRegexJobInWorker,
  setRegexWorkerDepsForTests,
} = await import('./worker-client')

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  errorHandler: ((error: Error) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null

  postMessage(message: ApplyWorkerJob): void {
    this.sent.push(message)
    this.onJob?.(message)
  }

  terminate(): void { this.terminated = true }
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void { this.messageHandler = handler }
  setErrorHandler(handler: (error: Error) => void): void { this.errorHandler = handler }
  respond(response: ApplyWorkerResponse): void { this.messageHandler?.(response) }
}

interface ManualTimer {
  fn: () => void
  cancelled: boolean
  ms: number
}

function makeHarness() {
  resetRegexWorkerForTests()
  const spawned: FakeWorker[] = []
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => {
      const worker = new FakeWorker()
      spawned.push(worker)
      return worker
    },
    scheduleTimer: (fn, ms) => {
      const timer = { fn, cancelled: false, ms }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    isSupported: () => true,
    isPageVisible: () => true,
    schedulerLagMs: () => 0,
  })
  const fireTimer = (index: number) => {
    const timer = timers[index]
    if (timer && !timer.cancelled) {
      timer.cancelled = true
      timer.fn()
    }
  }
  return { spawned, timers, fireTimer }
}

function applyScript(body: string, script: ApplyWorkerScript): string {
  const regex = compileRegex(script.pattern, script.flags)
  if (!regex) throw new Error('invalid pattern')
  let result = replaceWithinRegexSearchWindow(
    body,
    regex,
    script.pattern,
    script.flags,
    script.replaceString,
    script.replaceString,
  )
  for (const trim of script.trimStrings) {
    if (trim === '') continue
    let iterations = 0
    while (result.includes(trim)) {
      result = result.replaceAll(trim, '')
      if (++iterations >= 32) break
    }
  }
  return result
}

function echoWorker(fake: FakeWorker): void {
  const handled = new Set<number>()
  const handle = (job: ApplyWorkerJob) => {
    if (handled.has(job.jobId)) return
    handled.add(job.jobId)
    try {
      let result = job.body
      const scriptElapsedMs: number[] = []
      job.scripts.forEach((script, scriptIndex) => {
        fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex, scriptId: script.scriptId, scriptName: script.scriptName })
        result = applyScript(result, script)
        scriptElapsedMs.push(3)
        fake.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex, result, elapsedMs: 3 })
      })
      fake.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: scriptElapsedMs.length * 3, scriptElapsedMs })
    } catch (error) {
      fake.respond({
        type: 'error',
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: 3,
      })
    }
  }
  for (const job of fake.sent) handle(job)
  fake.onJob = handle
}

function workerScript(pattern: string, replaceString = '', id = pattern): ApplyWorkerScript {
  return { pattern, flags: 'g', replaceString, trimStrings: [], scriptId: id, scriptName: id }
}

describe('regex worker client', () => {
  test('dispatch starvation blames no script and preserves queued work', async () => {
    const { spawned, fireTimer } = makeHarness()
    try {
      const first = runRegexJobInWorker({ op: 'apply', body: 'aaa', scripts: [workerScript('a', 'b', 'slow')] })
      const second = runRegexJobInWorker({ op: 'apply', body: 'hello', scripts: [workerScript('hello', 'hi', 'safe')] })
      expect(spawned[0].sent).toHaveLength(1)

      fireTimer(0)
      fireTimer(1)
      const timeout = await first.catch((error) => error)
      expect(timeout).toBeInstanceOf(RegexWorkerTimeoutError)
      expect(timeout.scriptId).toBeUndefined()
      expect(timeout.completedScriptCount).toBe(0)
      expect(timeout.checkpointResult).toBe('aaa')
      expect(spawned[0].terminated).toBe(true)
      expect(spawned).toHaveLength(2)

      echoWorker(spawned[1])
      expect(await second).toMatchObject({ result: 'hi', scriptElapsedMs: [3] })
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('progress re-arms the per-script deadline', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'ab',
        scripts: [workerScript('a', 'A', 'first'), workerScript('b', 'B', 'second')],
      })
      const fake = spawned[0]
      const job = fake.sent[0]
      fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'first' })
      expect(timers[0].cancelled).toBe(true)
      fake.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: 0, result: 'Ab', elapsedMs: 3 })
      fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 1, scriptId: 'second' })
      expect(timers[1].cancelled).toBe(true)

      fireTimer(2)
      fireTimer(3)
      const timeout = await promise.catch((error) => error)
      expect(timeout.scriptId).toBe('second')
      expect(timeout.scriptIndex).toBe(1)
      expect(timeout.completedScriptCount).toBe(1)
      expect(timeout.checkpointResult).toBe('Ab')
      expect(timeout.phase).toBe('execution')
      expect(timeout.environmentCongested).toBe(false)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('batches scripts into one body round trip', async () => {
    const { spawned } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'foo boo',
        scripts: [workerScript('foo', 'bar'), workerScript('o+', '<$&>')],
      })
      echoWorker(spawned[0])
      const outcome = await promise
      expect(spawned[0].sent).toHaveLength(1)
      expect(outcome.result).toBe('bar b<oo>')
      expect(outcome.scriptElapsedMs).toEqual([3, 3])
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('the post-deadline grace lets an already-finished innocent regex win the task race', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'a',
        scripts: [workerScript('a', 'A', 'instant')],
      })
      const worker = spawned[0]
      const job = worker.sent[0]
      worker.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'instant' })

      // The primary timer happened to win against the queued worker result.
      fireTimer(1)
      expect(timers[2].ms).toBe(50)
      worker.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: 0, result: 'A', elapsedMs: 0 })
      worker.respond({ type: 'result', jobId: job.jobId, op: 'apply', result: 'A', elapsedMs: 0, scriptElapsedMs: [0] })

      expect((await promise).result).toBe('A')
      expect(worker.terminated).toBe(false)
      expect(timers[2].cancelled).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('hidden or globally starved workers receive the extended grace and diagnostic attribution', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      setRegexWorkerDepsForTests({
        isPageVisible: () => false,
        schedulerLagMs: () => 900,
      })
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'a',
        scripts: [workerScript('a', 'A', 'innocent')],
      })
      const job = spawned[0].sent[0]
      spawned[0].respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'innocent' })

      fireTimer(1)
      expect(timers[2].ms).toBe(1_000)
      fireTimer(2)
      const timeout = await promise.catch((error) => error)
      expect(timeout).toBeInstanceOf(RegexWorkerTimeoutError)
      expect(timeout.pageVisible).toBe(false)
      expect(timeout.schedulerLagMs).toBe(900)
      expect(timeout.environmentCongested).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('distinct-message jobs are never dropped at any queue depth', async () => {
    const { spawned } = makeHarness()
    try {
      const promises = Array.from({ length: 100 }, (_, index) => runRegexJobInWorker({
        op: 'apply', body: String(index), scripts: [workerScript(String(index))], dedupeKey: `m${index}|ai`,
      }))
      expect(spawned[0].sent).toHaveLength(1)

      echoWorker(spawned[0])
      const outcomes = await Promise.allSettled(promises)
      expect(outcomes.every((entry) => entry.status === 'fulfilled')).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('a newer job supersedes only queued jobs with the same dedupeKey, never the active one', async () => {
    const { spawned } = makeHarness()
    try {
      const activeJob = runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a', 'A')], dedupeKey: 'm1|ai' })
      const staleRender = runRegexJobInWorker({ op: 'apply', body: 'b', scripts: [workerScript('b', 'OLD')], dedupeKey: 'm2|ai' })
      const otherMessage = runRegexJobInWorker({ op: 'apply', body: 'c', scripts: [workerScript('c', 'C')], dedupeKey: 'm3|ai' })
      const freshRender = runRegexJobInWorker({ op: 'apply', body: 'b', scripts: [workerScript('b', 'NEW')], dedupeKey: 'm2|ai' })

      await expect(staleRender).rejects.toBeInstanceOf(RegexJobSupersededError)

      echoWorker(spawned[0])
      expect((await activeJob).result).toBe('A')
      expect((await otherMessage).result).toBe('C')
      expect((await freshRender).result).toBe('NEW')
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('a stale render retry never displaces an already-queued fresher render of the same message', async () => {
    const { spawned } = makeHarness()
    try {
      const occupies = runRegexJobInWorker({ op: 'apply', body: 'x', scripts: [workerScript('x', 'X')], dedupeKey: 'other|ai', dedupeGeneration: 1 })
      const fresh = runRegexJobInWorker({ op: 'apply', body: 'b', scripts: [workerScript('b', 'FRESH')], dedupeKey: 'm1|ai', dedupeGeneration: 5 })
      const staleRetry = runRegexJobInWorker({ op: 'apply', body: 'b', scripts: [workerScript('b', 'STALE')], dedupeKey: 'm1|ai', dedupeGeneration: 4 })

      await expect(staleRetry).rejects.toBeInstanceOf(RegexJobSupersededError)

      echoWorker(spawned[0])
      expect((await occupies).result).toBe('X')
      expect((await fresh).result).toBe('FRESH')
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('a same-key job arriving while its predecessor is active leaves the active job untouched', async () => {
    const { spawned } = makeHarness()
    try {
      const first = runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a', 'V1')], dedupeKey: 'm1|ai' })
      const second = runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a', 'V2')], dedupeKey: 'm1|ai' })
      expect(spawned[0].sent).toHaveLength(1)

      echoWorker(spawned[0])
      expect((await first).result).toBe('V1')
      expect((await second).result).toBe('V2')
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('a cold worker keeps the spawn deadline until it signals ready, then falls to the kill deadline', async () => {
    const { spawned, timers } = makeHarness()
    try {
      const promise = runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a', 'A')] })
      expect(timers[0].ms).toBe(COLD_SPAWN_KILL_MS)

      spawned[0].respond({ type: 'ready' })
      expect(timers[0].cancelled).toBe(true)
      expect(timers[1].ms).toBe(KILL_MS)

      echoWorker(spawned[0])
      expect((await promise).result).toBe('A')
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('unsupported environments reject without spawning', async () => {
    const { spawned } = makeHarness()
    try {
      setRegexWorkerDepsForTests({ isSupported: () => false })
      await expect(runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a')] }))
        .rejects.toBeInstanceOf(RegexWorkerUnsupportedError)
      expect(spawned).toHaveLength(0)
    } finally {
      resetRegexWorkerForTests()
    }
  })
})
