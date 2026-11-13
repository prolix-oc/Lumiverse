import { afterAll, beforeAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'
import type { RegexWorkerLike } from './worker-client'
import type { RegexScript } from '@/types/regex'

const toastCalls: string[] = []
mock.module('@/lib/toast', () => ({
  toast: { warning: (m: string) => toastCalls.push(m), success: () => {}, error: () => {}, info: () => {} },
}))
mock.module('@/i18n', () => ({
  default: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  i18n: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  initI18n: async () => {}, ensureLanguageLoaded: async () => {}, changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'ui-language',
}))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))
const storeState: Record<string, unknown> = {}
mock.module('@/store', () => ({
  useStore: Object.assign((s?: (x: typeof storeState) => unknown) => s ? s(storeState) : storeState, {
    getState: () => storeState, setState: () => {}, subscribe: () => () => {},
  }),
}))
const persisted: string[] = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string, payload: Record<string, unknown>) => {
      if (payload.quarantined === true) persisted.push(id)
      return {}
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false, getDisplayResolverForChat: () => null,
}))

const { applyDisplayRegexTiered, resetTieredPipelineForTests } = await import('./pipeline')
const { resetRegexEvidenceForTests } = await import('./evidence')
const { resetRegexWorkerForTests, setRegexWorkerDepsForTests } = await import('./worker-client')

let backendCalls = 0
const realFetch = globalThis.fetch

// `congested` is the self-hosted case: server shares the machine, so its
// sandbox deadline blows for the same reason the client's did.
function installBackend(mode: 'congested' | 'healthy' | 'offline'): void {
  backendCalls = 0
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    backendCalls += 1
    if (mode === 'offline') throw new Error('backend unreachable')
    const body = JSON.parse(init?.body ?? '{}') as { content?: string; scripts?: Array<{ id: string }> }
    const ids = (body.scripts ?? []).map((s) => s.id)
    return {
      ok: true,
      json: async () => ({
        result: body.content ?? '',
        cacheable: false,
        timed_out_script_ids: mode === 'congested' ? ids : [],
      }),
    }
  }) as unknown as typeof fetch
}

class StallingWorker implements RegexWorkerLike {
  private handler: ((m: ApplyWorkerResponse) => void) | null = null
  postMessage(job: ApplyWorkerJob): void {
    const first = job.scripts[0]
    if (!first) return
    this.handler?.({
      type: 'progress', jobId: job.jobId, scriptIndex: 0,
      ...(first.scriptId ? { scriptId: first.scriptId } : {}),
      ...(first.scriptName ? { scriptName: first.scriptName } : {}),
    })
  }
  terminate(): void {}
  setMessageHandler(h: (m: ApplyWorkerResponse) => void): void { this.handler = h }
  setErrorHandler(): void {}
}

// A cold worker on first launch: construction, chunk fetch and module init all
// happen before it can acknowledge a script, so the deadline can fire while
// currentScript is still null.
class SilentWorker implements RegexWorkerLike {
  postMessage(): void {}
  terminate(): void {}
  setMessageHandler(): void {}
  setErrorHandler(): void {}
}

interface ManualTimer { fn: () => void; cancelled: boolean }

function coldStartHarness() {
  resetRegexWorkerForTests()
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => new SilentWorker(),
    scheduleTimer: (fn) => {
      const t: ManualTimer = { fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    isSupported: () => true,
    // An idle phone is slow
    isPageVisible: () => true,
    schedulerLagMs: () => 0,
  })
  const fireLatest = (): void => {
    const t = [...timers].reverse().find((e) => !e.cancelled)
    t?.fn()
  }
  return { fireLatest }
}

function fakeHarness(congestedCanary: boolean) {
  resetRegexWorkerForTests()
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => new StallingWorker(),
    scheduleTimer: (fn) => {
      const t: ManualTimer = { fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    isSupported: () => true,
    isPageVisible: () => !congestedCanary,
    schedulerLagMs: () => congestedCanary ? 5_000 : 0,
  })
  const fireLatest = (): void => {
    const t = [...timers].reverse().find((e) => !e.cancelled)
    t?.fn()
  }
  return { fireLatest }
}

function script(id: string, over: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id,
    find_regex: id, replace_string: `<${id}>`,
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...over,
  }
}

const context = { isUser: false, depth: 0 }
const flush = async (): Promise<void> => { for (let i = 0; i < 2; i += 1) await Promise.resolve() }

async function drive<T>(pending: Promise<T>, fireLatest: () => void, maxTicks = 60): Promise<T> {
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < maxTicks && !settled; i += 1) {
    await flush()
    if (!settled) fireLatest()
  }
  await flush()
  return pending
}

// The pipeline warns per skipped script. Assertions still surface failures.
const realWarn = console.warn
beforeAll(() => { console.warn = () => {} })
afterAll(() => { console.warn = realWarn })

afterEach(() => {
  resetRegexWorkerForTests(); resetRegexEvidenceForTests(); resetTieredPipelineForTests()
  toastCalls.length = 0; persisted.length = 0
  globalThis.fetch = realFetch
})

const SCRIPTS = 10
const RENDERS = 500

async function quarantinedCount(
  backend: 'congested' | 'healthy' | 'offline',
  congestedCanary: boolean,
): Promise<number> {
  resetRegexEvidenceForTests(); resetTieredPipelineForTests(); persisted.length = 0
  installBackend(backend)
  const ids = Array.from({ length: SCRIPTS }, (_, i) => `s${i}`)
  for (let r = 0; r < RENDERS; r += 1) {
    const { fireLatest } = fakeHarness(congestedCanary)
    await drive(
      applyDisplayRegexTiered(ids.join(' '), ids.map((id) => script(id)), context),
      fireLatest,
    )
  }
  return new Set(persisted).size
}

// Every script here is a fixed literal: linear time, no backtracking, provably
// innocent. A timeout against one is evidence about the machine, never about
// the pattern, so none of these cases may produce durable evidence.
describe('a literal pattern is never permanently quarantined on timing evidence', () => {
  test(`canary calm, backend clears (${SCRIPTS * RENDERS} applications)`, async () => {
    expect(await quarantinedCount('healthy', false)).toBe(0)
  }, 300000)

  test('canary congested, backend clears', async () => {
    expect(await quarantinedCount('healthy', true)).toBe(0)
  }, 300000)

  test('canary congested, backend unreachable', async () => {
    expect(await quarantinedCount('offline', true)).toBe(0)
  }, 300000)

  // A co-located backend times out for the same reason the client did, so its
  // agreement is a second reading of one confounded signal, not corroboration.
  test('canary calm, backend confirms', async () => {
    expect(await quarantinedCount('congested', false)).toBe(0)
  }, 300000)

  // environmentCongested selects the grace duration but is not read at the
  // quarantine decision, so a correct congestion verdict does not prevent it.
  test('canary congested, backend confirms', async () => {
    expect(await quarantinedCount('congested', true)).toBe(0)
  }, 300000)
})

describe('a cold-start timeout is not evidence about any script', () => {
  const BENIGN_NESTED = '(「[^」]*」(?:「[^」]*」)*)*'

  test('a benign nested-quantifier pattern is not quarantined when the worker never acknowledged it', async () => {
    const { fireLatest } = coldStartHarness()
    installBackend('congested')
    const quoted = script('quoted', { find_regex: BENIGN_NESTED, replace_string: 'X' })
    await drive(
      applyDisplayRegexTiered('「a」「b」', [quoted], context),
      fireLatest,
    )
    expect(new Set(persisted).has('quoted')).toBe(false)
  }, 30000)
})

describe('a stalled worker is not evidence about the pattern', () => {
  // Burning CPU and starved of CPU both present as ack then silence, so a
  // stall cannot justify durable evidence against the script that was running.
  test('a script whose worker never replies is not permanently quarantined', async () => {
    const { fireLatest } = fakeHarness(false)
    installBackend('congested')
    const stalled = script('stalled')
    await drive(
      applyDisplayRegexTiered('stalled', [stalled], context),
      fireLatest,
    )
    expect(new Set(persisted).has('stalled')).toBe(false)
  }, 30000)

  // A healthy backend times each script against its own budget and flags only
  // the ones that individually exceed it, rather than the whole batch.
  function installDiscriminatingBackend(budgetMs: number): void {
    backendCalls = 0
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      backendCalls += 1
      const body = JSON.parse(init?.body ?? '{}') as {
        content?: string
        scripts?: Array<{ id: string; find_regex: string; flags: string }>
      }
      const timedOut: string[] = []
      for (const s of body.scripts ?? []) {
        const startedAt = performance.now()
        try { new RegExp(s.find_regex, s.flags).test(body.content ?? '') } catch { /* invalid */ }
        if (performance.now() - startedAt > budgetMs) timedOut.push(s.id)
      }
      return {
        ok: true,
        json: async () => ({ result: body.content ?? '', cacheable: false, timed_out_script_ids: timedOut }),
      }
    }) as unknown as typeof fetch
  }

  test('a backtracking pattern is convicted without taking its neighbour down', async () => {
    resetRegexWorkerForTests()
    setRegexWorkerDepsForTests({
      scheduleTimer: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
      isPageVisible: () => true,
    })
    installDiscriminatingBackend(500)

    const evil = script('evil', { find_regex: '((a)*)*$', replace_string: 'X' })
    const innocent = script('innocent', { find_regex: 'zzz', replace_string: 'Y' })
    await applyDisplayRegexTiered(`${'a'.repeat(52)}!`, [evil, innocent], context)

    // Outcome is engine and speed dependent, so assert the causal link.
    expect(new Set(persisted).has('evil')).toBe(backendCalls > 0)
    expect(new Set(persisted).has('innocent')).toBe(false)
  }, 60000)
})
