import { describe, expect, test } from 'bun:test'

import {
  createTokenCountScheduler,
  type TokenCountRequest,
  type TokenCountResult,
} from './tokenCountScheduler'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

type Run = {
  request: TokenCountRequest
  signal: AbortSignal
  deferred: Deferred<TokenCountResult>
}

type Callback = {
  entryId: string
  cacheKey: string
  count?: number
  error?: unknown
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve()
  }
}

function request(
  entryId: string,
  cacheKey: string,
  priority: TokenCountRequest['priority'] = 'interactive',
): TokenCountRequest {
  return {
    entryId,
    cacheKey,
    model: 'tokenizer-main',
    content: `content for ${entryId}`,
    priority,
  }
}

function createHarness(options: { maxConcurrent?: number; activityPauseMs?: number } = {}) {
  let now = 0
  let nextTimerId = 1
  const timers = new Map<number, { due: number; callback: () => void }>()
  const runs: Run[] = []
  const results: Callback[] = []
  const errors: Callback[] = []
  const yields: Array<Deferred<void>> = []
  const scheduler = createTokenCountScheduler({
    run(nextRequest, signal) {
      const deferred = createDeferred<TokenCountResult>()
      runs.push({ request: nextRequest, signal, deferred })
      return deferred.promise
    },
    onResult(nextRequest, result, consumer) {
      results.push({ entryId: consumer.entryId, cacheKey: nextRequest.cacheKey, count: result.count })
    },
    onError(nextRequest, error, consumer) {
      errors.push({ entryId: consumer.entryId, cacheKey: nextRequest.cacheKey, error })
    },
    yieldControl() {
      return yields.shift()?.promise ?? Promise.resolve()
    },
    setTimeout(callback, delayMs) {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { due: now + delayMs, callback })
      return timerId as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout(timer) {
      timers.delete(timer as unknown as number)
    },
    now: () => now,
  }, options)

  const advance = (milliseconds: number) => {
    now += milliseconds
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .sort(([left], [right]) => left - right)
    for (const [timerId, timer] of due) {
      timers.delete(timerId)
      timer.callback()
    }
  }

  return { scheduler, runs, results, errors, yields, timers, advance }
}

describe('token count scheduler', () => {
  test('starts interactive work before adjacent work and never exceeds its two-wide bound', async () => {
    const harness = createHarness()
    harness.scheduler.setPaused(true)
    harness.scheduler.schedule(request('adjacent', 'adjacent-key', 'adjacent'))
    harness.scheduler.schedule(request('interactive-one', 'interactive-one-key'))
    harness.scheduler.schedule(request('interactive-two', 'interactive-two-key'))
    harness.scheduler.schedule(request('interactive-three', 'interactive-three-key'))

    harness.scheduler.setPaused(false)
    await flush()

    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual([
      'interactive-one',
      'interactive-two',
    ])

    harness.runs[0].deferred.resolve({ count: 1, approximate: false })
    await flush(12)

    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual([
      'interactive-one',
      'interactive-two',
      'interactive-three',
    ])
  })

  test('dedupes by cache key and promotes queued sweep work for every consumer', async () => {
    const harness = createHarness()
    const first = request('entry-a', 'shared-key', 'sweep')
    const promoted = request('entry-b', 'shared-key', 'interactive')

    harness.scheduler.schedule(first)
    harness.scheduler.schedule(promoted)
    await flush()

    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0].request).toEqual(first)

    harness.runs[0].deferred.resolve({ count: 23, approximate: false })
    await flush()

    expect(harness.results).toEqual([
      { entryId: 'entry-a', cacheKey: 'shared-key', count: 23 },
      { entryId: 'entry-b', cacheKey: 'shared-key', count: 23 },
    ])
  })

  test('cancels one consumer without aborting or suppressing another shared consumer', async () => {
    const harness = createHarness()
    const first = harness.scheduler.schedule(request('entry-a', 'shared-key'))
    harness.scheduler.schedule(request('entry-b', 'shared-key'))
    await flush()

    first.cancel()
    expect(harness.runs[0].signal.aborted).toBeFalse()

    harness.runs[0].deferred.resolve({ count: 9, approximate: false })
    await flush()

    expect(harness.results).toEqual([{ entryId: 'entry-b', cacheKey: 'shared-key', count: 9 }])
  })

  test('invalidates queued and running entry consumers and suppresses their late results', async () => {
    const harness = createHarness()
    harness.scheduler.schedule(request('running', 'running-key'))
    await flush()

    harness.scheduler.setPaused(true)
    harness.scheduler.schedule(request('queued', 'queued-key'))
    harness.scheduler.invalidateEntry('queued')
    harness.scheduler.invalidateEntry('running')

    expect(harness.runs[0].signal.aborted).toBeTrue()
    harness.runs[0].deferred.resolve({ count: 11, approximate: false })
    harness.scheduler.setPaused(false)
    await flush()

    expect(harness.runs).toHaveLength(1)
    expect(harness.results).toEqual([])
    expect(harness.errors).toEqual([])
  })
  test('cancels matching consumers while preserving a shared nonmatching consumer', async () => {
    const harness = createHarness({ maxConcurrent: 2 })
    harness.scheduler.setPaused(true)
    harness.scheduler.schedule(request('entry-a', 'shared-key'))
    harness.scheduler.schedule(request('entry-b', 'shared-key'))
    harness.scheduler.schedule(request('entry-a', 'entry-a-only'))
    harness.scheduler.setPaused(false)
    await flush()

    expect(harness.runs).toHaveLength(2)
    harness.scheduler.invalidateEntry('entry-a')
    expect(harness.runs[0].signal.aborted).toBeFalse()
    expect(harness.runs[1].signal.aborted).toBeTrue()

    harness.runs[0].deferred.resolve({ count: 19, approximate: false })
    harness.runs[1].deferred.resolve({ count: 17, approximate: false })
    await flush(12)

    expect(harness.results).toEqual([
      { entryId: 'entry-b', cacheKey: 'shared-key', count: 19 },
    ])
    expect(harness.errors).toEqual([])
  })

  test('does not poison requests scheduled after repeated invalidation', async () => {
    const harness = createHarness()
    harness.scheduler.setPaused(true)
    harness.scheduler.invalidateEntry('future')
    harness.scheduler.invalidateEntry('future')
    harness.scheduler.schedule(request('future', 'future-key'))
    harness.scheduler.setPaused(false)
    await flush()

    expect(harness.runs).toHaveLength(1)
    harness.runs[0].deferred.resolve({ count: 23, approximate: false })
    await flush()

    expect(harness.results).toEqual([{ entryId: 'future', cacheKey: 'future-key', count: 23 }])
    expect(harness.errors).toEqual([])
  })


  test('abortAll aborts active tasks, drops queued tasks, and suppresses stale callbacks', async () => {
    const harness = createHarness()
    harness.scheduler.schedule(request('first', 'first-key'))
    harness.scheduler.schedule(request('second', 'second-key'))
    harness.scheduler.schedule(request('third', 'third-key'))
    await flush()

    expect(harness.runs).toHaveLength(2)
    harness.scheduler.abortAll()
    expect(harness.runs.every(({ signal }) => signal.aborted)).toBeTrue()

    harness.runs[0].deferred.resolve({ count: 1, approximate: false })
    harness.runs[1].deferred.reject(new Error('late failure'))
    await flush()

    expect(harness.runs).toHaveLength(2)
    expect(harness.results).toEqual([])
    expect(harness.errors).toEqual([])

    harness.scheduler.schedule(request('fresh', 'fresh-key'))
    await flush()
    expect(harness.runs).toHaveLength(3)
  })

  test('parks adjacent work after activity while keeping interactive work eligible', async () => {
    const harness = createHarness({ activityPauseMs: 500 })
    harness.scheduler.notifyActivity()
    harness.scheduler.schedule(request('adjacent', 'adjacent-key', 'adjacent'))
    harness.scheduler.schedule(request('interactive', 'interactive-key'))
    await flush()

    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['interactive'])

    harness.advance(499)
    await flush()
    expect(harness.runs).toHaveLength(1)

    harness.advance(1)
    await flush()
    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['interactive', 'adjacent'])
  })

  test('retains queued work while paused and resumes it explicitly', async () => {
    const harness = createHarness()
    harness.scheduler.setPaused(true)
    harness.scheduler.schedule(request('paused', 'paused-key'))
    await flush()

    expect(harness.runs).toHaveLength(0)

    harness.scheduler.setPaused(false)
    await flush()
    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['paused'])
  })

  test('releases sweep work one item per pumpSweep call', async () => {
    const harness = createHarness()
    harness.scheduler.schedule(request('sweep-one', 'sweep-one-key', 'sweep'))
    harness.scheduler.schedule(request('sweep-two', 'sweep-two-key', 'sweep'))
    await flush()

    expect(harness.runs).toHaveLength(0)

    harness.scheduler.pumpSweep()
    await flush()
    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['sweep-one'])

    harness.runs[0].deferred.resolve({ count: 3, approximate: false })
    await flush()
    expect(harness.runs).toHaveLength(1)

    harness.scheduler.pumpSweep()
    await flush()
    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['sweep-one', 'sweep-two'])
  })

  test('waits for injected yielding before starting the next queued task', async () => {
    const harness = createHarness()
    const yieldDeferred = createDeferred<void>()
    harness.yields.push(yieldDeferred)
    harness.scheduler.schedule(request('first', 'first-key'))
    harness.scheduler.schedule(request('second', 'second-key'))
    harness.scheduler.schedule(request('third', 'third-key'))
    await flush()

    expect(harness.runs).toHaveLength(2)
    harness.runs[0].deferred.resolve({ count: 1, approximate: false })
    await flush()
    expect(harness.runs).toHaveLength(2)

    yieldDeferred.resolve()
    await flush()
    expect(harness.runs.map(({ request: nextRequest }) => nextRequest.entryId)).toEqual(['first', 'second', 'third'])
  })

  test('reports current non-abort errors and suppresses abort errors', async () => {
    const harness = createHarness()
    harness.scheduler.schedule(request('failure', 'failure-key'))
    await flush()

    const failure = new Error('count failed')
    harness.runs[0].deferred.reject(failure)
    await flush()
    expect(harness.errors).toEqual([{ entryId: 'failure', cacheKey: 'failure-key', error: failure }])

    harness.scheduler.schedule(request('aborted', 'aborted-key'))
    await flush()
    harness.runs[1].deferred.reject({ name: 'AbortError' })
    await flush()
    expect(harness.errors).toHaveLength(1)
  })

  test('disposes idempotently, clears activity timers, and permanently rejects scheduling', async () => {
    const harness = createHarness()
    harness.scheduler.notifyActivity()
    harness.scheduler.schedule(request('running', 'running-key'))
    await flush()

    harness.scheduler.dispose()
    harness.scheduler.dispose()

    expect(harness.runs[0].signal.aborted).toBeTrue()
    expect(harness.timers).toHaveLength(0)
    expect(() => harness.scheduler.schedule(request('after-dispose', 'after-dispose-key')))
      .toThrow('TOKEN_SCHEDULER_DISPOSED')

    harness.runs[0].deferred.resolve({ count: 7, approximate: false })
    await flush()
    expect(harness.results).toEqual([])
    expect(harness.errors).toEqual([])
  })
})
