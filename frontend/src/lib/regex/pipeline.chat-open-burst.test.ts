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
mock.module('@/store', () => ({
  useStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) => selector ? selector(storeState) : storeState,
    { getState: () => storeState, setState: () => {}, subscribe: () => () => {} },
  ),
}))

const evidenceReports: string[] = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string) => {
      evidenceReports.push(id)
      return {}
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => null,
}))

const { applyDisplayRegexTiered, resetTieredPipelineForTests } = await import('./pipeline')
const { resetRegexEvidenceForTests } = await import('./evidence')
const { resetRegexWorkerForTests, setRegexWorkerDepsForTests } = await import('./worker-client')

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null
  postMessage(job: ApplyWorkerJob): void { this.sent.push(job); this.onJob?.(job) }
  terminate(): void { this.terminated = true }
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void { this.messageHandler = handler }
  setErrorHandler(): void {}
  respond(message: ApplyWorkerResponse): void { this.messageHandler?.(message) }
}

function makeHarness() {
  resetRegexWorkerForTests()
  const spawned: FakeWorker[] = []
  const timers: Array<{ fn: () => void; cancelled: boolean; ms: number }> = []
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
  return { spawned }
}

function echoWorker(worker: FakeWorker): void {
  const handled = new Set<number>()
  const handle = (job: ApplyWorkerJob) => {
    if (handled.has(job.jobId)) return
    handled.add(job.jobId)
    let result = job.body
    const scriptElapsedMs: number[] = []
    for (let index = 0; index < job.scripts.length; index += 1) {
      const entry = job.scripts[index]!
      worker.respond({ type: 'progress', jobId: job.jobId, scriptIndex: index, scriptId: entry.scriptId, scriptName: entry.scriptName })
      result = result.replace(new RegExp(entry.pattern, entry.flags), entry.replaceString)
      scriptElapsedMs.push(1)
      worker.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: index, result, elapsedMs: 1 })
    }
    worker.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: scriptElapsedMs.length, scriptElapsedMs })
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

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

afterEach(() => {
  resetRegexWorkerForTests()
  resetRegexEvidenceForTests()
  resetTieredPipelineForTests()
  toastCalls.length = 0
  evidenceReports.length = 0
})

const MESSAGES = 32

describe('chat-open burst of distinct messages', () => {
  test('a healthy worker serves every message without drops or backend fallback', async () => {
    const { spawned } = makeHarness()
    let backendCalls = 0
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: { body?: string }) => {
      backendCalls += 1
      const body = JSON.parse(init?.body ?? '{}') as { content?: string }
      return new Response(JSON.stringify({
        result: body.content ?? '',
        cacheable: false,
        timed_out_script_ids: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    try {
      const scripts = [
        script('greet', { find_regex: 'foo', replace_string: 'bar' }),
        script('mark', { find_regex: '★■', replace_string: '' }),
        script('noop-a', { find_regex: 'zzz-a', replace_string: '' }),
        script('noop-b', { find_regex: 'zzz-b', replace_string: '' }),
      ]
      const promises = Array.from({ length: MESSAGES }, (_, index) => applyDisplayRegexTiered(
        `msg${index} foo ★■`,
        scripts,
        { isUser: false, depth: index, chatId: 'chat-1', messageId: `m${index}` },
      ))
      await flush()
      expect(spawned).toHaveLength(1)
      echoWorker(spawned[0]!)

      const results = await Promise.all(promises)
      results.forEach((outcome, index) => {
        expect(outcome.result).toBe(`msg${index} bar `)
      })
      expect(spawned[0]!.sent).toHaveLength(MESSAGES)
      expect(backendCalls).toBe(0)
      expect(toastCalls).toHaveLength(0)
      expect(evidenceReports).toHaveLength(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
