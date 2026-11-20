/// <reference types="bun-types" />

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const getLoginUrl = mock(async (_providerId: string, _callbackURL: string) => ({ url: 'https://identity.example/authorize' }))
const getLinkUrl = mock(async (_providerId: string, _callbackURL: string) => ({ url: 'https://identity.example/link' }))

mock.module('@/api/sso-providers', () => ({
  ssoProvidersApi: {
    getLoginUrl,
    getLinkUrl,
  },
}))

const dom = new JSDOM('', { url: 'https://lumiverse.example/login' })
const previousWindow = globalThis.window
const previousCrypto = globalThis.crypto
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
// HTTP pages expose getRandomValues but not randomUUID.
Object.defineProperty(dom.window.crypto, 'randomUUID', { configurable: true, value: undefined })
Object.defineProperty(dom.window.crypto, 'getRandomValues', { configurable: true, value: (bytes: Uint8Array) => {
  bytes.fill(0x11); bytes[8] = 0x01; return bytes
} })
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: dom.window.crypto })

const { startSsoPopup } = await import('./ssoPopup')

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  getLoginUrl.mockClear()
  getLinkUrl.mockClear()
})

afterAll(() => {
  dom.window.close()
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previousCrypto })
  mock.restore()
})

test('closes the opened window after a successful SSO completion', async () => {
  let closeCalls = 0
  const popup = {
    closed: false,
    close: () => { closeCalls += 1 },
    focus: () => undefined,
    location: { href: 'about:blank' },
  }
  Object.defineProperty(dom.window, 'open', {
    configurable: true,
    value: () => popup,
  })

  const resultPromise = startSsoPopup({ providerId: 'example', flow: 'login' })
  await Promise.resolve()

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: dom.window.location.origin,
    data: {
      type: 'lumiverse:sso-complete',
      payload: {
        flow: 'login',
        providerId: 'example',
        flowId: FLOW_ID,
        ok: true,
      },
    },
  }))

  await expect(resultPromise).resolves.toMatchObject({ ok: true, flowId: FLOW_ID })
  expect(closeCalls).toBe(1)
  const callback = new URL(getLoginUrl.mock.calls[0]![1] as string)
  expect(callback.searchParams.has('mode')).toBe(false)
})

function useRedirectWindow(overrides: Record<string, unknown> = {}) {
  const assign = mock(() => {})
  const open = mock(() => null)
  const host = {
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5, standalone: true },
    location: { origin: dom.window.location.origin, assign },
    open,
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  return { assign, open }
}

test('iPhone Home Screen sign-in redirects without reserving a popup', async () => {
  const { assign, open } = useRedirectWindow()

  await expect(startSsoPopup({ providerId: 'example', flow: 'login', returnTo: '/chat/one' })).resolves.toBeNull()

  expect(open).not.toHaveBeenCalled()
  expect(assign).toHaveBeenCalledWith('https://identity.example/authorize')
  const callback = new URL(getLoginUrl.mock.calls[0]![1] as string)
  expect(callback.origin).toBe(dom.window.location.origin)
  expect(callback.searchParams.get('mode')).toBe('redirect')
  expect(callback.searchParams.get('returnTo')).toBe('/chat/one')
})

test.each(['standalone', 'fullscreen'])('iPadOS desktop identity uses %s display mode for SSO linking', async (mode) => {
  const { assign, open } = useRedirectWindow({
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 },
    matchMedia: (query: string) => ({ matches: query === `(display-mode: ${mode})` }),
  })

  await expect(startSsoPopup({ providerId: 'example', flow: 'link' })).resolves.toBeNull()

  expect(open).not.toHaveBeenCalled()
  expect(getLoginUrl).not.toHaveBeenCalled()
  expect(assign).toHaveBeenCalledWith('https://identity.example/link')
  expect(new URL(getLinkUrl.mock.calls[0]![1] as string).searchParams.get('flow')).toBe('link')
})

test('same-window SSO rejects unsafe provider URLs', async () => {
  const { assign } = useRedirectWindow()
  getLoginUrl.mockResolvedValueOnce({ url: 'javascript:alert(1)' })

  await expect(startSsoPopup({ providerId: 'example', flow: 'login' })).rejects.toThrow('invalid authorization URL')
  expect(assign).not.toHaveBeenCalled()
})

test('same-window SSO surfaces authorization startup failures', async () => {
  const { assign } = useRedirectWindow()
  getLoginUrl.mockRejectedValueOnce(new Error('Provider unavailable'))

  await expect(startSsoPopup({ providerId: 'example', flow: 'login' })).rejects.toThrow('Provider unavailable')
  expect(assign).not.toHaveBeenCalled()
})
