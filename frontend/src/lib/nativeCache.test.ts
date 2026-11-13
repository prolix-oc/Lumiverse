import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

mock.module('@/api/client', () => ({ BASE_URL: '/api/v1' }))
const dom = new JSDOM('', { url: 'https://server.example/' })
const previous = new Map(['window', 'document', 'localStorage', 'requestAnimationFrame', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const request = mock(async () => ({ accepted: true }))
let frames: FrameRequestCallback[] = []
let interactive = 1
let respond: (response: Response) => void
const fetchConfig = mock(() => new Promise<Response>(resolve => { respond = resolve }))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  localStorage: { configurable: true, value: dom.window.localStorage },
  requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) },
  fetch: { configurable: true, value: fetchConfig },
})
Object.defineProperties(dom.window, {
  __LUMIVERSE_MOBILE__: { configurable: true, value: true },
  __LUMIVERSE_PLATFORM__: { configurable: true, value: 'ios' },
  __LUMIVERSE_IOS_NATIVE__: { configurable: true, value: { version: 1, request } },
  __lumiverseDisplayPerformance: { configurable: true, value: { snapshot: () => ({ milestones: { interactive } }) } },
})
const { isNativeCacheDocument, reportNativeCacheReady } = await import('./nativeCache')
const { initializeSafeThemeMode, getSafeThemeState, subscribeSafeThemeState } = await import('./safeThemeMode')

beforeEach(() => {
  dom.window.document.documentElement.innerHTML = '<head><meta name="lumiverse-native-cache" content="1"><meta name="lumiverse-build-id" content="test-build"></head><body><div id="root"><main>Ready</main></div></body>'
  dom.window.localStorage.clear()
  frames = []
  interactive = 1
  request.mockClear()
  fetchConfig.mockClear()
})
afterAll(() => {
  dom.window.close()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  mock.restore()
})

test('local boot acknowledges its build while the session check keeps the root empty', async () => {
  expect(isNativeCacheDocument()).toBe(true)
  dom.window.document.getElementById('root')!.replaceChildren()
  interactive = 0
  reportNativeCacheReady()
  frames.shift()!(0)
  expect(request).not.toHaveBeenCalled()
  interactive = 1
  frames.shift()!(0)
  await Promise.resolve()
  expect(request).toHaveBeenCalledWith('cache.ready', { buildId: 'test-build' })
  expect(frames).toHaveLength(0)
})

test('ordinary server pages do not acknowledge a native bundle', () => {
  dom.window.document.querySelector('meta[name="lumiverse-native-cache"]')!.remove()
  expect(isNativeCacheDocument()).toBe(false)
  reportNativeCacheReady()
  expect(frames).toHaveLength(0)
  expect(request).not.toHaveBeenCalled()
})

test('unknown native bootstrap paints safe immediately and refreshes its public snapshot', async () => {
  const changed = mock(() => {})
  const unsubscribe = subscribeSafeThemeState(changed)
  expect(await initializeSafeThemeMode()).toEqual({ active: true, source: 'server' })
  expect(fetchConfig).toHaveBeenCalledWith('/api/v1/runtime-config', expect.objectContaining({ cache: 'no-store' }))
  respond(Response.json({ safeThemeMode: false }))
  await Bun.sleep(0)
  expect(getSafeThemeState()).toEqual({ active: false, source: null })
  expect(dom.window.localStorage.getItem('lumiverse.native-cache.safe-theme')).toBe('0')
  expect(changed).toHaveBeenCalledTimes(2)
  unsubscribe()
})

test('a native bootstrap uses its stored value even when the backend fails', async () => {
  dom.window.localStorage.setItem('lumiverse.native-cache.safe-theme', '0')
  expect(await initializeSafeThemeMode()).toEqual({ active: false, source: null })
  respond(new Response(null, { status: 503 }))
  await Bun.sleep(0)
  expect(getSafeThemeState().active).toBe(false)
})

test('ordinary frontend startup still waits for server configuration', async () => {
  dom.window.document.querySelector('meta[name="lumiverse-native-cache"]')!.remove()
  let completed = false
  const initialized = initializeSafeThemeMode().then(value => { completed = true; return value })
  await Promise.resolve()
  expect(completed).toBe(false)
  respond(Response.json({ safeThemeMode: true }))
  expect(await initialized).toEqual({ active: true, source: 'server' })
})
