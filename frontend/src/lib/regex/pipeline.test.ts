import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'
import type { RegexWorkerLike } from './worker-client'
import type { RegexScript } from '@/types/regex'

const toastCalls: string[] = []
mock.module('@/lib/toast', () => ({
  toast: {
    warning: (message: string) => toastCalls.push(message),
    success: () => {}, error: () => {}, info: () => {},
  },
}))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key, language: 'en', on: () => {}, off: () => {} },
  i18n: { t: (key: string) => key, language: 'en', on: () => {}, off: () => {} },
  initI18n: async () => {}, ensureLanguageLoaded: async () => {}, changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'ui-language',
}))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))

const storeState: Record<string, unknown> = {}
const useStoreShim = Object.assign(
  (selector?: (state: typeof storeState) => unknown) => selector ? selector(storeState) : storeState,
  { getState: () => storeState, setState: (patch: Record<string, unknown>) => Object.assign(storeState, patch), subscribe: () => () => {} },
)
mock.module('@/store', () => ({ useStore: useStoreShim }))

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return {}
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))

const registryState: { owned: boolean; resolver: Record<string, unknown> | null } = { owned: false, resolver: null }
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => registryState.owned,
  getDisplayResolverForChat: () => registryState.owned ? registryState.resolver : null,
}))

const {
  applyDisplayRegexTiered,
  resetTieredPipelineForTests,
} = await import('./pipeline')
const {
  getRegexExecTier,
  quarantineRegexScript,
  readRegexScriptEvidence,
  resetRegexEvidenceForTests,
} = await import('./evidence')
const { KILL_MS, resetRegexWorkerForTests, setRegexWorkerDepsForTests } = await import('./worker-client')

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  errorHandler: ((error: Error) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null
  postMessage(job: ApplyWorkerJob): void { this.sent.push(job); this.onJob?.(job) }
  terminate(): void { this.terminated = true }
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void { this.messageHandler = handler }
  setErrorHandler(handler: (error: Error) => void): void { this.errorHandler = handler }
  respond(message: ApplyWorkerResponse): void { this.messageHandler?.(message) }
}

interface ManualTimer { fn: () => void; cancelled: boolean; ms: number }

function makeHarness(options?: { spawnThrows?: boolean }) {
  resetRegexWorkerForTests()
  const spawned: FakeWorker[] = []
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => {
      if (options?.spawnThrows) throw new Error('worker construction failed')
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
  const fireLatestTimer = () => {
    const primary = [...timers].reverse().find((entry) => !entry.cancelled)
    if (primary) {
      primary.cancelled = true
      primary.fn()
    }
    const grace = [...timers].reverse().find((entry) => !entry.cancelled)
    if (grace) {
      grace.cancelled = true
      grace.fn()
    }
  }
  return { spawned, timers, fireLatestTimer }
}

function echoWorker(worker: FakeWorker): void {
  const handled = new Set<number>()
  const handle = (job: ApplyWorkerJob) => {
    if (handled.has(job.jobId)) return
    handled.add(job.jobId)
    let result = job.body
    const scriptElapsedMs: number[] = []
    for (let index = 0; index < job.scripts.length; index += 1) {
      const script = job.scripts[index]!
      worker.respond({ type: 'progress', jobId: job.jobId, scriptIndex: index, scriptId: script.scriptId, scriptName: script.scriptName })
      result = result.replace(new RegExp(script.pattern, script.flags), script.replaceString)
      for (const trim of script.trimStrings) result = trim ? result.replaceAll(trim, '') : result
      scriptElapsedMs.push(2)
      worker.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: index, result, elapsedMs: 2 })
    }
    worker.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: scriptElapsedMs.length * 2, scriptElapsedMs })
  }
  for (const job of worker.sent) handle(job)
  worker.onJob = handle
}

function script(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id, find_regex: 'x', replace_string: 'y',
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...overrides,
  }
}

const context = { isUser: false, depth: 0 }
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

afterEach(() => {
  resetRegexWorkerForTests()
  resetRegexEvidenceForTests()
  resetTieredPipelineForTests()
  toastCalls.length = 0
  evidenceReports.length = 0
  registryState.owned = false
  registryState.resolver = null
})

describe('isolated regex pipeline', () => {
  test('proven no-match scripts start neither workers, deadlines nor backend requests', async () => {
    const { spawned, timers } = makeHarness()
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      const body = 'a'.repeat(100_000)
      const outcome = await applyDisplayRegexTiered(body, [
        script('pathological', { find_regex: '(a+)+ENDING' }),
        script('raw', { find_regex: 'status.*ENDING', substitute_macros: 'raw', replace_string: '{{user}}' }),
      ], context)
      expect(outcome.result).toBe(body)
      expect(spawned).toHaveLength(0)
      expect(timers).toHaveLength(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('gating preserves ordered matches introduced across worker and backend batches', async () => {
    const { spawned } = makeHarness()
    const bodies: Array<{ content: string; preprocessed?: boolean; scripts: RegexScript[] }> = []
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ result: 'Alice' }), { status: 200 })
    }) as typeof fetch)
    try {
      const promise = applyDisplayRegexTiered('x', [
        script('absent', { find_regex: 'ABSENTENDING', substitute_macros: 'raw', replace_string: '{{user}}' }),
        script('introduce', { find_regex: 'x', replace_string: 'statusENDING' }),
        script('consume', { find_regex: 'statusENDING', substitute_macros: 'raw', replace_string: '{{user}}' }),
        script('finish', { find_regex: 'Alice', replace_string: 'done' }),
      ], context)
      await flush()
      echoWorker(spawned[0])
      expect((await promise).result).toBe('done')
      expect(bodies).toHaveLength(1)
      expect(bodies[0].content).toBe('statusENDING')
      expect(bodies[0].preprocessed).toBe(true)
      expect(bodies[0].scripts.map((s) => s.id)).toEqual(['consume'])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('an edit re-syncs the session overlay from the persisted row instead of dropping quarantine', () => {
    const original = script('edited', { find_regex: 'a+', updated_at: 1 })
    quarantineRegexScript(original)
    expect(evidenceReports).toEqual([{ id: 'edited', payload: { quarantined: true } }])

    // The row the panel refetches after the edit still carries the flag, so the
    // rebuilt overlay entry keeps the script skipped.
    const editedStillQuarantined = {
      ...original,
      find_regex: '(a|aa)+$',
      updated_at: 2,
      metadata: { regex_evidence: { quarantined: true } },
    }
    expect(readRegexScriptEvidence(editedStillQuarantined)).toEqual({ quarantined: true })
    expect(getRegexExecTier(editedStillQuarantined)).toEqual({ tier: 'quarantined', reason: 'quarantined' })

    // A row without the flag (cleared server-side) wins over the stale overlay
    // entry once the definition fingerprint no longer matches.
    const editedAndCleared = { ...original, find_regex: 'b+', updated_at: 3, metadata: {} }
    expect(readRegexScriptEvidence(editedAndCleared)).toEqual({})
    expect(getRegexExecTier(editedAndCleared)).toEqual({
      tier: 'worker',
      reason: 'user-authored regexes require isolated execution',
    })
  })

  test('compatible scripts share one worker body round trip', async () => {
    const { spawned } = makeHarness()
    const promise = applyDisplayRegexTiered('foo boo', [
      script('one', { find_regex: 'foo', replace_string: 'bar' }),
      script('two', { find_regex: 'o+', replace_string: '<$&>' }),
    ], context)
    await flush()
    echoWorker(spawned[0])
    expect((await promise).result).toBe('bar b<oo>')
    expect(spawned[0].sent).toHaveLength(1)
    expect(spawned[0].sent[0].scripts).toHaveLength(2)
  })

  test('macro-free raw and after imports use native replacement in the worker', async () => {
    const { spawned } = makeHarness()
    const promise = applyDisplayRegexTiered('foo bar', [
      script('raw-captures', {
        find_regex: '(foo)',
        replace_string: '[$1]',
        substitute_macros: 'raw',
      }),
      script('after-without-macros', {
        find_regex: 'bar',
        replace_string: 'baz',
        substitute_macros: 'after',
      }),
    ], context)
    await flush()
    echoWorker(spawned[0])

    expect((await promise).result).toBe('[foo] baz')
    expect(spawned[0].sent).toHaveLength(1)
    expect(spawned[0].sent[0].scripts).toHaveLength(2)
  })

  test('an unconfirmed local timeout is skipped once without durable quarantine', async () => {
    const { spawned, fireLatestTimer } = makeHarness()
    const slow = script('slow', { find_regex: 'a' })
    const safe = script('safe', { find_regex: 'b', replace_string: 'B' })
    const promise = applyDisplayRegexTiered('ab', [slow, safe], context)
    await flush()

    const firstWorker = spawned[0]
    const firstJob = firstWorker.sent[0]
    firstWorker.respond({ type: 'progress', jobId: firstJob.jobId, scriptIndex: 0, scriptId: 'slow', scriptName: 'slow' })
    fireLatestTimer()
    await flush()

    expect(firstWorker.terminated).toBe(true)
    expect(spawned).toHaveLength(2)
    echoWorker(spawned[1])
    expect((await promise).result).toBe('aB')
    expect(getRegexExecTier(slow).tier).toBe('worker')
    expect(getRegexExecTier(safe).tier).toBe('worker')
    expect(evidenceReports).toEqual([])
  })

  describe('worst-case congestion and backtracking regressions', () => {
    test('worker starvation before start cannot randomly quarantine the first innocent regex', async () => {
      const { spawned, fireLatestTimer } = makeHarness()
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        result: 'AB',
        touched_vars: [],
        cacheable: true,
        timed_out_script_ids: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      try {
        const innocent = script('innocent-literal', { find_regex: 'a', replace_string: 'A' })
        const safe = script('safe-suffix', { find_regex: 'b', replace_string: 'B' })
        const promise = applyDisplayRegexTiered('ab', [innocent, safe], context)
        await flush()

        // No progress message: the browser scheduled the watchdog while the
        // worker itself never received enough CPU to acknowledge the job.
        fireLatestTimer()
        expect((await promise).result).toBe('AB')
        expect(spawned[0].terminated).toBe(true)
        expect(getRegexExecTier(innocent).tier).toBe('worker')
        expect(evidenceReports).toEqual([])
      } finally {
        fetchSpy.mockRestore()
      }
    })

    test('a mid-batch timeout resumes at its checkpoint and never reruns the completed prefix', async () => {
      const { spawned, fireLatestTimer } = makeHarness()
      const backendBodies: Array<{ content: string; scripts: RegexScript[] }> = []
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
        backendBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({
          result: 'AbC',
          touched_vars: [],
          cacheable: false,
          // The backend may time out more than one suffix script, but only the
          // one the browser acknowledged is independently corroborated.
          timed_out_script_ids: ['catastrophic', 'suffix'],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch)
      try {
        const prefix = script('prefix', { find_regex: 'a', replace_string: 'A' })
        const catastrophic = script('catastrophic', { find_regex: '(b+)+$', replace_string: 'B' })
        const suffix = script('suffix', { find_regex: '(c+)+$', replace_string: 'C' })
        const promise = applyDisplayRegexTiered('abc', [prefix, catastrophic, suffix], context)
        await flush()

        const firstWorker = spawned[0]
        const firstJob = firstWorker.sent[0]
        firstWorker.respond({ type: 'progress', jobId: firstJob.jobId, scriptIndex: 0, scriptId: 'prefix' })
        firstWorker.respond({ type: 'checkpoint', jobId: firstJob.jobId, scriptIndex: 0, result: 'Abc', elapsedMs: 1 })
        firstWorker.respond({ type: 'progress', jobId: firstJob.jobId, scriptIndex: 1, scriptId: 'catastrophic' })
        fireLatestTimer()

        expect((await promise).result).toBe('AbC')
        expect(backendBodies).toHaveLength(1)
        expect(backendBodies[0].content).toBe('Abc')
        expect(backendBodies[0].scripts.map((entry) => entry.id)).toEqual(['catastrophic', 'suffix'])
        expect(getRegexExecTier(prefix).tier).toBe('worker')
        expect(getRegexExecTier(catastrophic).tier).toBe('quarantined')
        expect(getRegexExecTier(suffix).tier).toBe('worker')
        expect(evidenceReports).toEqual([
          { id: 'catastrophic', payload: { quarantined: true } },
        ])
      } finally {
        fetchSpy.mockRestore()
      }
    })

    test('a started innocent regex remains active when only the congested browser times out', async () => {
      const { spawned, fireLatestTimer } = makeHarness()
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        result: 'ok',
        touched_vars: [],
        cacheable: true,
        timed_out_script_ids: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      try {
        const innocent = script('started-innocent', { find_regex: '^ok$', replace_string: 'ok' })
        const promise = applyDisplayRegexTiered('ok', [innocent], context)
        await flush()
        const job = spawned[0].sent[0]
        spawned[0].respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: innocent.id })
        fireLatestTimer()

        expect((await promise).result).toBe('ok')
        expect(getRegexExecTier(innocent).tier).toBe('worker')
        expect(evidenceReports).toEqual([])
      } finally {
        fetchSpy.mockRestore()
      }
    })
  })

  test('failed worker and backend boundaries return raw text without synchronous execution', async () => {
    makeHarness({ spawnThrows: true })
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    try {
      const risky = script('risky', { find_regex: '(a|aa)+$' })
      const body = `${'a'.repeat(40)}X`
      const outcome = await applyDisplayRegexTiered(body, [risky], context)
      expect(outcome).toMatchObject({ result: body, cacheable: false })
      expect(toastCalls).toEqual(['panels:regexPanel.unavailableDisplay'])
      expect(getRegexExecTier(risky).tier).toBe('worker')
      expect(evidenceReports).toEqual([])

      // A temporary failure must not consume the warning for a later real
      // quarantine of the same script.
      quarantineRegexScript(risky)
      await applyDisplayRegexTiered(body, [risky], context)
      expect(toastCalls).toEqual([
        'panels:regexPanel.unavailableDisplay',
        'panels:regexPanel.quarantinedDisplay',
      ])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('quarantined scripts skip without worker construction', async () => {
    const { spawned } = makeHarness()
    const quarantined = script('quarantined')
    quarantineRegexScript(quarantined)
    const result = await applyDisplayRegexTiered('x', [quarantined], context)
    expect(result.result).toBe('x')
    expect(spawned).toHaveLength(0)
  })

  test('temporary executor failures leave unchanged scripts eligible for a later successful render', async () => {
    makeHarness({ spawnThrows: true })
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    try {
      const unchanged = script('retry')
      expect(await applyDisplayRegexTiered('x', [unchanged], context)).toMatchObject({
        result: 'x', cacheable: false,
      })

      const { spawned } = makeHarness()
      const retry = applyDisplayRegexTiered('x', [unchanged], context)
      await flush()
      echoWorker(spawned[0])
      expect((await retry).result).toBe('y')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(evidenceReports).toEqual([])
      expect(toastCalls).toEqual(['panels:regexPanel.unavailableDisplay'])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('owned processing state reaches the final callback without transport', async () => {
    const applyScripts = mock(async ({ processingState }: { processingState?: string }) => ({ content: processingState ?? 'missing' }))
    registryState.owned = true
    registryState.resolver = { applyScripts }
    const result = await applyDisplayRegexTiered('body', [], { ...context, chatId: 'chat', processingState: '' })
    expect(result.result).toBe('')
    expect(applyScripts).toHaveBeenCalledTimes(1)
  })

  test('owned chats receive selected preset context through their resolver bypass', async () => {
    const { spawned } = makeHarness();
    registryState.owned = true;
    const applyScripts = mock(async (_args: unknown) => ({ content: 'owned:source', cacheable: false }));
    registryState.resolver = { applyScripts };
    const presetContext = { preset_id: 'source', variables: { local: { mode: 'captured' } } };
    const result = await applyDisplayRegexTiered('body', [], { ...context, chatId: 'chat', presetContext, presetRegexIds: ['source-rule'] });
    expect(result.result).toBe('owned:source');
    expect(applyScripts.mock.calls[0]?.[0]).toMatchObject({ context: { presetContext, presetRegexIds: ['source-rule'] } });
    expect(spawned).toHaveLength(0);
  });

  test('owned chats retain their resolver bypass', async () => {
    const { spawned } = makeHarness()
    registryState.owned = true
    registryState.resolver = { applyScripts: async ({ content }: { content: string }) => ({ content: `owned:${content}`, cacheable: false }) }
    const result = await applyDisplayRegexTiered('x', [script('owned')], { ...context, chatId: 'chat' })
    expect(result).toMatchObject({ result: 'owned:x', cacheable: false })
    expect(spawned).toHaveLength(0)
  })
})
