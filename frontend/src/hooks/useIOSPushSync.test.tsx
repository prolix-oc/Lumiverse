import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const globals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
})
let state = 'active', enrolled = true, permission = 'granted'
const listeners = new Set<(state: string) => void>()
const registration = { deviceId: 'test-installation', bundleId: 'chat.lumiverse.ios', environment: 'development', deviceToken: 'aa' }
let register: (() => Promise<typeof registration>) | undefined
const subscribe = mock(async (_registration: unknown, _options: unknown) => {})
const registerPush = mock(async () => register ? register() : registration)
mock.module('@/api/push', () => ({ pushApi: {
  getIOSInfo: async () => ({ configured: true, delivery: 'direct' }),
  listSubscriptions: async () => enrolled ? [{ type: 'ios_apns', device_id: registration.deviceId, bundle_id: registration.bundleId, environment: registration.environment }] : [],
  subscribeIOS: subscribe,
} }))
mock.module('@/lib/ios-native', () => ({
  hasIOSNativeBridge: () => true,
  getIOSNotificationStatus: async () => ({ ...registration, available: true, permission }),
  registerIOSPush: registerPush,
}))
mock.module('@/lib/ios-app-state', () => ({
  getIOSAppState: () => state,
  subscribeIOSAppState: (listener: (state: string) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
}))
const { useIOSPushSync } = await import('./useIOSPushSync')
let root: Root
function Probe({ account }: { account: string | null }) { useIOSPushSync(account); return null }
const render = async (account: string | null) => { await act(async () => root.render(<Probe account={account} />)) }
const settle = async (ms = 160) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
beforeEach(() => {
  state = 'active'; enrolled = true; permission = 'granted'; register = undefined
  subscribe.mockReset(); subscribe.mockImplementation(async () => {})
  registerPush.mockClear()
  root = createRoot(document.createElement('div'))
})
afterEach(async () => { await act(async () => root.unmount()) })
afterAll(() => {
  mock.restore(); dom.window.close()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('a failed server registration retries without needing another foreground event', async () => {
  subscribe.mockImplementationOnce(async () => { throw new Error('network unavailable') })
  await render('owner'); await settle()
  expect(subscribe).toHaveBeenCalledTimes(1)
  await settle(1100)
  expect(subscribe).toHaveBeenCalledTimes(2)
})

test('a token rotation during registration queues another pass instead of being dropped', async () => {
  let release!: (value: typeof registration) => void
  register = () => new Promise(resolve => { release = resolve })
  await render('owner'); await settle()
  window.dispatchEvent(new dom.window.Event('lumiverse:ios-push-token'))
  register = undefined
  release(registration); await settle()
  expect(subscribe).toHaveBeenCalledTimes(2)
})

test('a registration that finishes after logout cannot enroll the previous account', async () => {
  let release!: (value: typeof registration) => void
  register = () => new Promise(resolve => { release = resolve })
  await render('owner'); await settle()
  await render(null)
  release(registration); await settle()
  expect(subscribe).not.toHaveBeenCalled()
})

test('foreground recovery preserves notification opt-out and never prompts implicitly', async () => {
  enrolled = false
  await render('owner'); await settle()
  window.dispatchEvent(new dom.window.Event('online')); await settle()
  expect(registerPush).not.toHaveBeenCalled()
  enrolled = true; permission = 'default'
  window.dispatchEvent(new dom.window.Event('online')); await settle()
  expect(registerPush).not.toHaveBeenCalled()
})
