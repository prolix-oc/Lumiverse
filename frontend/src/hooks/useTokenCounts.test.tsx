import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

const profiles: Array<{ id: string; model?: string; is_default?: boolean }> = []
let activeProfileId: string | null = null

const useStoreMock = <T,>(selector: (state: {
  activeProfileId: string | null
  profiles: Array<{ id: string; model?: string; is_default?: boolean }>
}) => T): T => selector({ activeProfileId, profiles })

type CountResult = { token_count: number | null; char_count: number }
type CountCall = {
  model: string
  content: string
  options: { signal?: AbortSignal } | undefined
}
type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

const countCalls: CountCall[] = []
const pendingCounts: Array<Deferred<CountResult>> = []
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

mock.module('@/store', () => ({ useStore: useStoreMock }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['HTMLDivElement', globalObject.HTMLDivElement],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLDivElement: dom.window.HTMLDivElement,
  SVGElement: dom.window.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

dom.window.requestAnimationFrame = (callback) => {
  callback(0)
  return 0
}


const {
  invalidateTokenCountsForEntry,
  resetTokenCountRuntime,
  resolveTokenCount,
  useActiveTokenizerModel,
  useTokenCounts,
} = await import('./useTokenCounts')
const {
  clearTokenCountCache,
  makeTokenCountCacheKey,
  setTokenCount,
} = await import('@/lib/tokenCountCache')
const {
  TOKEN_COUNT_APPROXIMATE_EXTENSION,
  TOKEN_COUNT_EXTENSION,
  TOKEN_COUNT_HASH_EXTENSION,
  TOKEN_COUNT_LENGTH_EXTENSION,
  TOKEN_COUNT_MODEL_EXTENSION,
} = await import('@/lib/storedTokenCount')
const { fnv1a32 } = await import('@/lib/tokenCountCache')
mock.restore()

const { tokenizersApi } = await import('@/api/tokenizers')
const countForModelSpy = spyOn(tokenizersApi, 'countForModel').mockImplementation(
  (model: string, content: string, options?: { signal?: AbortSignal }): Promise<CountResult> => {
    countCalls.push({ model, content, options })
    const deferred = createDeferred<CountResult>()
    pendingCounts.push(deferred)
    return deferred.promise
  },
)

type HookOptions = {
  entryId?: string
  content: string
  extensions?: Record<string, unknown>
  enabled?: boolean
}
type HookSurface = {
  model: string | null
  count: number | null
  approximate: boolean
  status: 'idle' | 'counting' | 'ready'
  requestCount(): void
  cancel(): void
}

let hookSurface: HookSurface
let activeModel: string | null = null
const mountedRoots = new Set<Root>()

/* eslint-disable react-compiler/react-compiler */
function HookHarness({ options }: { options: HookOptions }) {
  activeModel = useActiveTokenizerModel()
  hookSurface = useTokenCounts(options) as HookSurface
  return null
}
/* eslint-enable react-compiler/react-compiler */

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function renderHook(options: HookOptions): Promise<{ root: Root; host: HTMLDivElement; rerender(next: HookOptions): Promise<void> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  mountedRoots.add(root)
  const render = async (next: HookOptions) => {
    await act(async () => {
      root.render(createElement(HookHarness, { options: next }))
      await flush()
    })
  }
  await render(options)
  return { root, host, rerender: render }
}

async function unmountRoot(root: Root): Promise<void> {
  if (!mountedRoots.has(root)) return
  await act(async () => {
    root.unmount()
    await flush()
  })
  mountedRoots.delete(root)
}

function setProfiles(next: Array<{ id: string; model?: string; is_default?: boolean }>, active: string | null): void {
  profiles.splice(0, profiles.length, ...next)
  activeProfileId = active
}

async function requestCount(): Promise<void> {
  await act(async () => {
    hookSurface.requestCount()
    await flush()
  })
}

async function settleCount(index: number, result: CountResult): Promise<void> {
  await act(async () => {
    pendingCounts[index]?.resolve(result)
    await flush()
  })
}

async function rejectCount(index: number, reason: unknown): Promise<void> {
  await act(async () => {
    pendingCounts[index]?.reject(reason)
    await flush()
  })
}

afterEach(async () => {
  for (const root of [...mountedRoots]) await unmountRoot(root)
  await act(async () => {
    for (const pending of pendingCounts.splice(0)) pending.resolve({ token_count: 0, char_count: 0 })
    await flush()
  })
  countCalls.length = 0
  profiles.length = 0
  activeProfileId = null
  activeModel = null
  clearTokenCountCache()
  resetTokenCountRuntime()
  document.body.replaceChildren()
})

afterAll(() => {
  countForModelSpy.mockRestore()
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useTokenCounts', () => {
  test('resolves the active model, then the default model, and finally no model', async () => {
    setProfiles([
      { id: 'default', model: 'default-model', is_default: true },
      { id: 'active', model: 'active-model' },
    ], 'active')
    const { root, rerender } = await renderHook({ content: 'content' })
    try {
      expect(activeModel).toBe('active-model')
      setProfiles([{ id: 'default', model: 'default-model', is_default: true }], null)
      await rerender({ content: 'content' })
      expect(activeModel).toBe('default-model')
      setProfiles([], null)
      await rerender({ content: 'content' })
      expect(activeModel).toBeNull()
    } finally {
      await unmountRoot(root)
    }
  })

  test('updates from cache subscriptions and resolves stored and cached values by authority', async () => {
    setProfiles([{ id: 'active', model: 'model-a' }], 'active')
    const content = 'cached content'
    const key = makeTokenCountCacheKey('model-a', content)
    const exactExtensions = {
      [TOKEN_COUNT_EXTENSION]: 9,
      [TOKEN_COUNT_MODEL_EXTENSION]: 'model-a',
      [TOKEN_COUNT_LENGTH_EXTENSION]: content.length,
      [TOKEN_COUNT_HASH_EXTENSION]: fnv1a32(content),
    }

    expect(resolveTokenCount({
      stored: { count: 9, exact: true, approximate: false, reason: 'exact' },
      cached: { count: 4, approximate: false, model: 'model-a', contentLength: content.length },
      estimate: 3,
    })).toEqual({ count: 9, approximate: false })
    expect(resolveTokenCount({
      stored: { count: 9, exact: false, approximate: true, reason: 'approximate' },
      cached: { count: 4, approximate: false, model: 'model-a', contentLength: content.length },
      estimate: 3,
    })).toEqual({ count: 4, approximate: false })

    const { root } = await renderHook({ content, extensions: exactExtensions })
    try {
      expect(hookSurface.count).toBe(9)
      expect(hookSurface.approximate).toBe(false)
      setTokenCount(key, { count: 12, approximate: false, model: 'model-a', contentLength: content.length })
      await act(flush)
      expect(hookSurface.count).toBe(9)

      const approximateContent = 'cache update'
      const approximateKey = makeTokenCountCacheKey('model-a', approximateContent)
      const second = await renderHook({ content: approximateContent })
      try {
        expect(hookSurface.count).toBeNull()
        setTokenCount(approximateKey, {
          count: 7,
          approximate: true,
          model: 'model-a',
          contentLength: approximateContent.length,
        })
        await act(flush)
        expect(hookSurface.count).toBe(7)
        expect(hookSurface.approximate).toBe(true)
      } finally {
        await unmountRoot(second.root)
      }
    } finally {
      await unmountRoot(root)
    }
  })

  test('requests exact counts, estimates null responses and failures, and never transports empty content', async () => {
    setProfiles([{ id: 'active', model: 'model-a' }], 'active')
    const { root, rerender } = await renderHook({ content: 'abcdef' })
    try {
      await requestCount()
      expect(hookSurface.status).toBe('counting')
      expect(countCalls).toHaveLength(1)
      expect(countCalls[0]?.options?.signal).toBeInstanceOf(AbortSignal)
      await settleCount(0, { token_count: 11, char_count: 6 })
      expect(hookSurface).toMatchObject({ count: 11, approximate: false, status: 'ready' })

      await rerender({ content: 'abcde' })
      await requestCount()
      await settleCount(1, { token_count: null, char_count: 5 })
      expect(hookSurface).toMatchObject({ count: 2, approximate: true, status: 'ready' })

      await rerender({ content: 'abcdefgh' })
      await requestCount()
      await rejectCount(2, new Error('tokenizer unavailable'))
      expect(hookSurface).toMatchObject({ count: 2, approximate: true, status: 'ready' })

      await rerender({ content: '' })
      await requestCount()
      expect(countCalls).toHaveLength(3)
      expect(hookSurface).toMatchObject({ count: 0, approximate: true, status: 'ready' })
    } finally {
      await unmountRoot(root)
    }
  })

  test('suppresses stale content and model responses', async () => {
    setProfiles([{ id: 'active', model: 'model-a' }], 'active')
    const { root, rerender } = await renderHook({ entryId: 'entry-a', content: 'old content' })
    try {
      await requestCount()
      expect(countCalls[0]).toMatchObject({ model: 'model-a', content: 'old content' })
      await rerender({ entryId: 'entry-a', content: 'new content' })
      await requestCount()
      setProfiles([{ id: 'active', model: 'model-b' }], 'active')
      await rerender({ entryId: 'entry-a', content: 'new content' })
      await requestCount()

      await settleCount(0, { token_count: 100, char_count: 11 })
      await settleCount(1, { token_count: 101, char_count: 11 })
      expect(hookSurface.status).toBe('counting')
      await settleCount(2, { token_count: 7, char_count: 11 })
      expect(hookSurface).toMatchObject({ model: 'model-b', count: 7, approximate: false, status: 'ready' })
    } finally {
      await unmountRoot(root)
    }
  })

  test('mounted invalidation aborts the request and resets the consumer', async () => {
    setProfiles([{ id: 'active', model: 'model-a' }], 'active')
    const content = 'pending entry content'
    const { root } = await renderHook({ entryId: 'entry-a', content })
    await requestCount()
    const firstSignal = countCalls[0]?.options?.signal
    try {
      await act(async () => {
        invalidateTokenCountsForEntry('entry-a')
        await flush()
      })
      expect(firstSignal?.aborted).toBe(true)
      expect(hookSurface.status).toBe('idle')

    } finally {
      await unmountRoot(root)
    }
  })
  test('ignores invalidation after the last consumer unmounts', async () => {
    setProfiles([{ id: 'active', model: 'model-a' }], 'active')
    const content = 'remounted entry content'
    const first = await renderHook({ entryId: 'entry-off-page', content })
    await requestCount()
    const firstSignal = countCalls[0]?.options?.signal
    await unmountRoot(first.root)
    expect(firstSignal?.aborted).toBe(true)

    await act(async () => {
      invalidateTokenCountsForEntry('entry-off-page')
      await flush()
    })

    const later = await renderHook({ entryId: 'entry-off-page', content })
    try {
      expect(hookSurface).toMatchObject({ count: null, status: 'idle' })
      await requestCount()
      expect(countCalls).toHaveLength(2)
      await settleCount(0, { token_count: 99, char_count: content.length })
      expect(hookSurface).toMatchObject({ count: null, status: 'counting' })
      await settleCount(1, { token_count: 23, char_count: content.length })
      expect(hookSurface).toMatchObject({ count: 23, approximate: false, status: 'ready' })
    } finally {
      await unmountRoot(later.root)
    }
  })
 })
