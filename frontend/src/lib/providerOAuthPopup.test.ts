import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { renderProviderOAuthLanding } from '../../../src/auth/provider-oauth-landing'
import { startProviderOAuthPopup } from './providerOAuthPopup'

const ORIGIN = 'https://lumiverse.example:8444'
const SESSION = '11111111-1111-4111-8111-111111111111'
const originalWindow = globalThis.window
let dom: JSDOM
let popup: { closed: boolean; opener: unknown; location: { href: string }; close: ReturnType<typeof mock>; focus: ReturnType<typeof mock> }
let intervals: Map<number, () => void>
let timeouts: Map<number, { callback: () => void; delay: number }>
let timerId: number

beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>', { url: ORIGIN })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  popup = {
    closed: false,
    opener: dom.window,
    location: { href: 'about:blank' },
    close: mock(() => { popup.closed = true }),
    focus: mock(() => {}),
  }
  dom.window.open = mock(() => popup as unknown as Window)
  intervals = new Map()
  timeouts = new Map()
  timerId = 0
  dom.window.setInterval = ((callback: () => void) => {
    intervals.set(++timerId, callback)
    return timerId
  }) as typeof dom.window.setInterval
  dom.window.clearInterval = (id) => { intervals.delete(id!) }
  dom.window.setTimeout = ((callback: () => void, delay: number) => {
    timeouts.set(++timerId, { callback, delay })
    return timerId
  }) as typeof dom.window.setTimeout
  dom.window.clearTimeout = (id) => { timeouts.delete(id!) }
})

afterEach(() => {
  dom.window.close()
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const tick = () => { for (const callback of [...intervals.values()]) callback() }
const runTimeout = (delay: number) => {
  for (const [id, timer] of [...timeouts]) {
    if (timer.delay !== delay) continue
    timeouts.delete(id)
    timer.callback()
  }
}

function start(provider: 'openrouter' | 'nanogpt', initiate = async () => ({
  auth_url: `https://${provider === 'openrouter' ? 'openrouter.ai' : 'nano-gpt.com'}/auth`,
  session_token: SESSION,
})) {
  return startProviderOAuthPopup({
    provider,
    callbackUrl: `${ORIGIN}/api/v1/${provider}/oauth-landing`,
    initiate,
  })
}

function message(payload: unknown, origin = ORIGIN) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin, data: payload }))
}

function landing(provider: 'openrouter' | 'nanogpt', options: { opener?: unknown; error?: string } = {}) {
  const callback = new JSDOM(renderProviderOAuthLanding({
    provider,
    code: options.error ? undefined : 'valid-code',
    state: SESSION,
    error: options.error,
    openerOrigin: ORIGIN,
  }, (origin) => origin === ORIGIN), { url: `${ORIGIN}/api/v1/${provider}/oauth-landing` })
  Object.defineProperty(callback.window, 'opener', { value: options.opener ?? null })
  Object.defineProperty(callback.window, 'localStorage', { value: dom.window.localStorage })
  const run = new Function('window', 'document', 'setTimeout', callback.window.document.querySelector('script')!.textContent!)
  return { callback, run: () => run(callback.window, callback.window.document, dom.window.setTimeout) }
}

describe('provider OAuth popup hand-off', () => {
  test.each(['openrouter', 'nanogpt'] as const)('%s reserves a popup before the initiation request completes', async (provider) => {
    const initiate = mock(async () => ({ auth_url: 'https://provider.example/auth', session_token: SESSION }))
    const flow = start(provider, initiate)
    expect(dom.window.open).toHaveBeenCalledWith('about:blank', `${provider}_auth`, expect.any(String))
    expect(initiate).not.toHaveBeenCalled()
    await flush()
    expect(popup.location.href).toBe('https://provider.example/auth')
    expect(popup.opener).toBe(dom.window)
    flow.cancel()
    await expect(flow.result).resolves.toBeNull()
    expect(intervals.size).toBe(0)
    expect(timeouts.size).toBe(0)
  })

  test.each(['openrouter', 'nanogpt'] as const)('%s receives the real landing page message and cleans up', async (provider) => {
    const flow = start(provider)
    await flush()
    const page = landing(provider, { opener: { postMessage: (data: unknown, origin: string) => queueMicrotask(() => message(data, origin)) } })
    page.run()
    await expect(flow.result).resolves.toEqual({ sessionToken: SESSION, code: 'valid-code' })
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(intervals.size).toBe(0)
    expect(dom.window.localStorage.getItem(`lumiverse:provider-oauth:${SESSION}`)).toBeNull()
    page.callback.window.close()
  })

  test.each(['openrouter', 'nanogpt'] as const)('%s completes through storage after a redirect loses its opener', async (provider) => {
    const flow = start(provider)
    await flush()
    const page = landing(provider)
    page.run()
    popup.closed = true
    tick()
    await expect(flow.result).resolves.toEqual({ sessionToken: SESSION, code: 'valid-code' })
    expect(dom.window.localStorage.getItem(`lumiverse:provider-oauth:${SESSION}`)).toBeNull()
    expect(intervals.size).toBe(0)
    expect([...timeouts.values()].some((timer) => timer.delay === 1500)).toBe(false)
    page.callback.window.close()
  })

  test('receives a channel callback when opener and storage are unavailable', async () => {
    const listeners = new Set<{ onmessage: ((event: { data: unknown }) => void) | null }>()
    class Channel {
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor(_name: string) { listeners.add(this) }
      postMessage(data: unknown) {
        for (const listener of [...listeners]) {
          if (listener !== this) queueMicrotask(() => listener.onmessage?.({ data }))
        }
      }
      close() { listeners.delete(this) }
    }
    Object.defineProperty(dom.window, 'BroadcastChannel', { value: Channel })
    const flow = start('nanogpt')
    await flush()
    const page = landing('nanogpt')
    Object.defineProperty(page.callback.window, 'BroadcastChannel', { value: Channel })
    Object.defineProperty(page.callback.window, 'localStorage', { value: { setItem: () => { throw new Error('Disabled') } } })
    page.run()
    await expect(flow.result).resolves.toEqual({ sessionToken: SESSION, code: 'valid-code' })
    expect(listeners.size).toBe(0)
    page.callback.window.close()
  })

  test('ignores other origins, providers and sessions and consumes a valid code once', async () => {
    const flow = start('openrouter')
    const completed = mock(() => {})
    void flow.result.then(completed)
    await flush()
    const payload = { type: 'openrouter_oauth_code', state: SESSION, code: 'valid-code' }
    message(payload, 'https://untrusted.example')
    message({ ...payload, state: 'other-session' })
    message({ ...payload, type: 'nanogpt_oauth_code' })
    await flush()
    expect(completed).not.toHaveBeenCalled()
    message(payload)
    message(payload)
    await expect(flow.result).resolves.toEqual({ sessionToken: SESSION, code: 'valid-code' })
    await flush()
    expect(completed).toHaveBeenCalledTimes(1)
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
  })

  test('reports a provider denial and releases the waiting flow', async () => {
    const flow = start('nanogpt')
    const failure = flow.result.catch((error: Error) => error)
    await flush()
    const page = landing('nanogpt', { error: 'access_denied' })
    page.run()
    tick()
    expect(await failure).toBeInstanceOf(Error)
    expect((await failure as Error).message).toBe('Authorization failed: access_denied')
    expect(intervals.size).toBe(0)
    page.callback.window.close()
  })

  test('does not request authorization when popups are blocked', async () => {
    dom.window.open = mock(() => null)
    const initiate = mock(async () => ({ auth_url: 'https://provider.example/auth', session_token: SESSION }))
    const flow = start('openrouter', initiate)
    await expect(flow.result).rejects.toThrow('Allow popups')
    expect(initiate).not.toHaveBeenCalled()
    expect(intervals.size).toBe(0)
  })

  test('cancellation during initiation prevents later popup navigation', async () => {
    let respond!: (result: { auth_url: string; session_token: string }) => void
    const flow = start('openrouter', () => new Promise((resolve) => { respond = resolve }))
    await flush()
    flow.cancel()
    respond({ auth_url: 'https://provider.example/auth', session_token: SESSION })
    await flush()
    await expect(flow.result).resolves.toBeNull()
    expect(popup.location.href).toBe('about:blank')
    expect(intervals.size).toBe(0)
    expect(timeouts.size).toBe(0)
  })

  test('closing the popup or timing out cancels and removes listeners and timers', async () => {
    const closed = start('openrouter')
    await flush()
    popup.closed = true
    tick()
    runTimeout(1500)
    await expect(closed.result).resolves.toBeNull()
    expect(timeouts.size).toBe(0)
    popup.closed = false
    const timedOut = start('nanogpt')
    await flush()
    runTimeout(5 * 60 * 1000)
    await expect(timedOut.result).resolves.toBeNull()
    expect(intervals.size).toBe(0)
    expect(timeouts.size).toBe(0)
  })

  test('failed initiation closes the reserved window', async () => {
    const flow = start('openrouter', async () => { throw new Error('Offline') })
    await expect(flow.result).rejects.toThrow('Offline')
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(intervals.size).toBe(0)
    expect(timeouts.size).toBe(0)
  })
})
