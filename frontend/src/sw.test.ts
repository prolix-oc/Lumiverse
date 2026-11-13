import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Exercise the actual worker event handler; caching is unrelated to push.
let navigationRouteDenylist: RegExp[] | undefined

mock.module('workbox-precaching', () => ({
  precacheAndRoute() {}, cleanupOutdatedCaches() {}, createHandlerBoundToURL() {},
}))
mock.module('workbox-routing', () => ({
  registerRoute() {},
  NavigationRoute: class {
    constructor(_handler: unknown, options?: { denylist?: RegExp[] }) {
      navigationRouteDenylist = options?.denylist
    }
  },
}))
mock.module('workbox-strategies', () => ({ CacheFirst: class {}, NetworkFirst: class {}, NetworkOnly: class {} }))
mock.module('workbox-expiration', () => ({ ExpirationPlugin: class {} }))
mock.module('workbox-background-sync', () => ({ BackgroundSyncPlugin: class {} }))

const originalSelf = globalThis.self
const handlers = new Map<string, (event: any) => void>()
const matchAll = mock(async (): Promise<any[]> => [])
const showNotification = mock(async (_title: string, _options: NotificationOptions) => {})
const getNotifications = mock(async (): Promise<any[]> => [{}])
const setAppBadge = mock(async (_count: number) => {})
const openWindow = mock(async (_url: string) => null)

;(globalThis as any).self = {
  addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  clients: { matchAll, openWindow },
  location: { origin: 'https://lumiverse.test' },
  registration: { showNotification, getNotifications },
  navigator: { setAppBadge },
}
await import('./sw')

afterAll(() => {
  if (originalSelf === undefined) delete (globalThis as any).self
  else (globalThis as any).self = originalSelf
  mock.restore()
})

beforeEach(() => {
  matchAll.mockReset()
  showNotification.mockReset()
  showNotification.mockImplementation(async () => {})
  getNotifications.mockReset()
  getNotifications.mockImplementation(async () => [{}])
  setAppBadge.mockReset()
  setAppBadge.mockImplementation(async () => {})
  openWindow.mockClear()
})

describe('notification clicks', () => {
  function client(url: string) {
    const value = { url, postMessage: mock(() => {}), focus: mock(async () => value) }
    return value
  }

  async function click(url = '/chat/chat-1') {
    let completion: Promise<unknown> | undefined
    handlers.get('notificationclick')!({
      notification: { close() {}, data: { url } },
      waitUntil(promise: Promise<unknown>) { completion = promise },
    })
    expect(completion).toBeDefined()
    await completion
  }

  test('focuses the existing chat without requesting navigation', async () => {
    const open = client('https://lumiverse.test/chat/chat-1?panel=details')
    matchAll.mockResolvedValue([open])
    await click()
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(open.postMessage).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  test('prefers a window that already displays the requested chat', async () => {
    const other = client('https://lumiverse.test/chat/chat-2')
    const open = client('https://lumiverse.test/chat/chat-1')
    matchAll.mockResolvedValue([other, open])
    await click()
    expect(other.focus).not.toHaveBeenCalled()
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(open.postMessage).not.toHaveBeenCalled()
  })

  test('still routes a different chat in an existing window', async () => {
    const open = client('https://lumiverse.test/chat/chat-2')
    matchAll.mockResolvedValue([open])
    await click()
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'NAVIGATE', url: '/chat/chat-1' })
  })

  test('opens a fresh route if an existing window cannot be focused', async () => {
    const open = client('https://lumiverse.test/chat/chat-1')
    open.focus.mockRejectedValue(new Error('Discarded window'))
    matchAll.mockResolvedValue([open])
    await click()
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith('/chat/chat-1')
  })
})

const payload = {
  title: 'Character', body: 'Response finished', tag: 'generation-chat-1',
  data: { url: '/chat/chat-1', chatId: 'chat-1' },
}

async function receivePush() {
  let completion: Promise<unknown> | undefined
  handlers.get('push')!({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => { completion = promise },
  })
  expect(completion).toBeDefined()
  await completion
}

function isSpaNavigation(url: string): boolean {
  const parsed = new URL(url, 'https://lumiverse.local')
  const pathAndSearch = parsed.pathname + parsed.search
  return !navigationRouteDenylist?.some((pattern) => pattern.test(pathAndSearch))
}

describe('service worker navigation routing', () => {
  test.each([
    '/widget.html',
    '/widget.html?desktopWidgetExtension=weather&desktopWidgetIndex=0',
  ])('does not send the widget entry point through the SPA fallback: %s', (url) => {
    expect(isSpaNavigation(url)).toBeFalse()
  })

  test('continues to send application routes through the SPA fallback', () => {
    expect(isSpaNavigation('/chat/chat-1?panel=details')).toBeTrue()
  })
})

describe('service worker push delivery', () => {
  test.each([
    ['foreground PWA', [{ visibilityState: 'visible', focused: true }]],
    ['visible unfocused PWA', [{ visibilityState: 'visible', focused: false }]],
    ['background PWA', [{ visibilityState: 'hidden', focused: false }]],
    ['closed PWA', []],
  ] as const)('displays an already delivered push for a %s', async (_name, clients) => {
    matchAll.mockImplementation(async () => [...clients])
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(payload.title, {
      body: payload.body, tag: payload.tag, data: payload.data,
      icon: '/icon-192.png', badge: '/icon-192.png', image: undefined,
    })
    expect(setAppBadge).toHaveBeenCalledWith(1)
  })

  test('keeps delivery working when notification enumeration fails', async () => {
    getNotifications.mockImplementation(async () => { throw new Error('Unavailable') })
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  test('keeps the push event successful when badging rejects', async () => {
    setAppBadge.mockImplementation(async () => { throw new Error('Badging denied') })
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
  })
})
