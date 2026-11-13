import { afterAll, beforeAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { cpus } from 'node:os'
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
const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload }); return {}
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false, getDisplayResolverForChat: () => null,
}))

const { applyDisplayRegexTiered, resetTieredPipelineForTests } = await import('./pipeline')
const { getRegexExecTier, resetRegexEvidenceForTests } = await import('./evidence')
const { KILL_MS, resetRegexWorkerForTests, setRegexWorkerDepsForTests } = await import('./worker-client')

function configureRealWorker(): void {
  resetRegexWorkerForTests()
  setRegexWorkerDepsForTests({
    scheduleTimer: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  })
}

function saturateCpu(threads: number): () => void {
  const src = `
    let stop = false
    self.onmessage = () => { stop = true; self.close() }
    while (!stop) { Math.sqrt(Math.random() * 1e9) }
  `
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
  const hogs: Worker[] = []
  for (let i = 0; i < threads; i += 1) hogs.push(new Worker(url, { type: 'module' }))
  return () => { for (const h of hogs) h.terminate(); URL.revokeObjectURL(url) }
}

function script(id: string): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id,
    find_regex: id, replace_string: `<${id}>`,
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1,
  }
}
const context = { isUser: false, depth: 0 }

// The pipeline warns per skipped script. Assertions still surface failures.
const realWarn = console.warn
beforeAll(() => { console.warn = () => {} })
afterAll(() => { console.warn = realWarn })

afterEach(() => {
  resetRegexWorkerForTests(); resetRegexEvidenceForTests(); resetTieredPipelineForTests()
  toastCalls.length = 0; evidenceReports.length = 0
})

// Saturates every core and is load dependent. Run with `bun run test:slow`.

describe('regex worker under CPU starvation', () => {
  test('starvation never produces durable evidence against a literal pattern', async () => {
    const cores = cpus().length
    for (const hogs of [0, cores, cores * 3]) {
      resetRegexEvidenceForTests(); resetTieredPipelineForTests()
      configureRealWorker()
      const scripts = ['a1', 'a2', 'a3', 'a4', 'a5'].map(script)
      const stop = hogs > 0 ? saturateCpu(hogs) : () => {}
      if (hogs > 0) await new Promise((r) => setTimeout(r, 150))
      const startedAt = Date.now()
      await applyDisplayRegexTiered('a1 a2 a3 a4 a5', scripts, context)
      const wallMs = Date.now() - startedAt
      stop()
      const quarantined = scripts.filter((s) => getRegexExecTier(s).tier === 'quarantined').length
      // No backend reachable, so a deadline can only skip for the render.
      expect({ hogs, wallOver: wallMs > KILL_MS, quarantined })
        .toEqual({ hogs, wallOver: wallMs > KILL_MS, quarantined: 0 })
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 60000)
})
