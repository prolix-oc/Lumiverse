import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { PushSubscriptionRecord } from '@/api/push'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://lumiverse.test' })
const globals = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
})
Object.defineProperty(dom.window, '__LUMIVERSE_MOBILE__', { value: true })
Object.defineProperty(dom.window, '__LUMIVERSE_PLATFORM__', { value: 'android' })
let transport: 'local' | 'fcm' = 'local', configured = false, permission = 'default'
let relay = false, relayAvailable = true, pendingPolls = 0
let enrollment: Record<string, string> | null = null
let rows: PushSubscriptionRecord[] = []
let currentRegistration = false
let loadRows: (() => Promise<PushSubscriptionRecord[]>) | undefined
const actions: string[] = []
const native: { onmessage?: (event: { data: string }) => void; postMessage(raw: string): void } = {
  postMessage(raw) {
    const request = JSON.parse(raw); actions.push(request.action)
    let result: unknown
    if (request.action === 'notifications.status') result = { available: true, permission, deviceId: 'android-device-12345678',
      transport, projectId: 'firebase-project', connected: true, enrollment, relayAvailable, encryptionVersion: 1 }
    if (request.action === 'notifications.register') {
      permission = 'granted'; result = { deviceId: 'android-device-12345678', transport, ...(transport === 'fcm' ? { deviceToken: 'token', projectId: 'firebase-project' } : {}) }
    }
    if (relay && request.action === 'notifications.register') result = { pending: true, enrollmentId: 'relay-enrollment' }
    if (request.action === 'notifications.poll') {
      pendingPolls++
      result = { deviceId: 'android-device-12345678', accountId: 'owner', transport: 'fcm', projectId: 'firebase-project',
        delivery: 'relay', enrollmentId: 'relay-enrollment', relayCredential: 'scoped-delivery-credential', encryption: { key: 'content-key', keyId: 'content-key-id' } }
    }
    if (request.action === 'notifications.save') enrollment = { destinationId: request.payload.destination.id,
      serverOrigin: request.payload.serverOrigin, serverInstanceId: request.payload.serverInstanceId, accountId: 'owner' }
    if (request.action === 'notifications.clear') enrollment = null
    if (request.action === 'notifications.current') result = currentRegistration
    queueMicrotask(() => native.onmessage?.({ data: JSON.stringify({ id: request.id, result: result ?? true }) }))
  },
}
Object.defineProperty(dom.window, 'lumiverseNotifications', { value: native })
const subscribeAndroid = mock(async (_registration?: unknown, _options?: unknown) => {
  const destination: PushSubscriptionRecord = { type: 'android_native', id: 'android-destination', user_id: 'owner', device_id: 'android-device-12345678', transport,
    user_agent: '', label: 'Lumiverse Android', created_at: 1, updated_at: 1 }
  rows = [destination]; return { destination, credential: 'private-credential', serverInstanceId: 'server-instance' }
})
const unsubscribe = mock(async () => { rows = [] })
const testPush = mock(async () => ({ success: true, sent: 1 }))
mock.module('@/api/push', () => ({ pushApi: {
  getAndroidInfo: async () => ({ configured, ...(relay ? { delivery: 'relay', relayUrl: 'https://fcm-relay.lumiverse.chat', encryptionRequired: true, encryptionVersion: 1 } : {}), projectId: 'firebase-project', serverInstanceId: 'server-instance', reason: configured ? null : 'Server needs Firebase configuration' }),
  listSubscriptions: async () => loadRows ? loadRows() : rows, subscribeAndroid, unsubscribe, test: testPush,
  getVapidPublicKey: () => { throw new Error('Android must not use browser push') },
} }))
const { usePushSubscription } = await import('./usePushSubscription')
const { useAndroidPushSync } = await import('./useAndroidPushSync')
let current!: ReturnType<typeof usePushSubscription>, root: Root
function Fixture() { const state = usePushSubscription(); useEffect(() => { current = state }, [state]); return null }
function SyncFixture() { useAndroidPushSync('owner'); return null }
beforeEach(() => { relay = false; relayAvailable = true; pendingPolls = 0; transport = 'local'; configured = false; permission = 'default'; enrollment = null; rows = []; actions.length = 0;
  currentRegistration = false; loadRows = undefined;
  subscribeAndroid.mockClear(); unsubscribe.mockClear(); testPush.mockClear(); root = createRoot(document.createElement('div')) })
afterEach(async () => { await act(async () => root.unmount()) })
afterAll(() => { dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } mock.restore() })
const mount = () => act(async () => { root.render(createElement(Fixture)) })

test('local Android enrolls, tests and removes native alerts without requiring Firebase or browser push', async () => {
  await mount()
  expect(current.registrationKind).toBe('native'); expect(current.registrationStatus).toBe('ready')
  await act(async () => { expect(await current.subscribe()).toBe(true) })
  expect(current.isSubscribed).toBe(true); expect(current.permissionState).toBe('granted')
  await current.testPush(); expect(testPush).toHaveBeenCalledWith('android-destination')
  await act(async () => current.unsubscribe('android-destination'))
  expect(current.isSubscribed).toBe(false); expect(actions).toContain('notifications.clear')
})
test('remote Android reports missing Firebase configuration without attempting enrollment', async () => {
  transport = 'fcm'; await mount()
  expect(current.isSupported).toBe(true); expect(current.registrationStatus).toBe('error')
  await expect(current.subscribe()).rejects.toThrow('Firebase configuration')
  expect(subscribeAndroid).not.toHaveBeenCalled()
})
test('stale or revoked native enrollment does not appear subscribed', async () => {
  enrollment = { destinationId: 'revoked', serverOrigin: 'https://lumiverse.test', serverInstanceId: 'server-instance', accountId: 'owner' }
  await mount(); expect(current.isSubscribed).toBe(false)
  await expect(current.testPush()).rejects.toThrow('Enable notifications')
})

test('startup sync preserves opt-in and never prompts a device that has not enrolled', async () => {
  await act(async () => root.render(createElement(SyncFixture)))
  expect(actions).toContain('notifications.account')
  expect(actions).not.toContain('notifications.register')
  expect(subscribeAndroid).not.toHaveBeenCalled()
})

test('startup and token sync refresh existing enrollment but leave a current token unchanged', async () => {
  await subscribeAndroid(); subscribeAndroid.mockClear(); permission = 'granted'
  await act(async () => root.render(createElement(SyncFixture)))
  expect(subscribeAndroid).toHaveBeenCalledTimes(1)
  expect(actions).toContain('notifications.save')
  currentRegistration = true
  await act(async () => { window.dispatchEvent(new dom.window.Event('lumiverse:android-push-token')) })
  expect(subscribeAndroid).toHaveBeenCalledTimes(1)
})

test('a disposed account sync cannot enroll after a delayed destination response', async () => {
  permission = 'granted'
  let resolveRows!: (value: PushSubscriptionRecord[]) => void
  loadRows = () => new Promise(resolve => { resolveRows = resolve })
  await act(async () => root.render(createElement(SyncFixture)))
  await act(async () => root.render(null))
  await act(async () => { resolveRows([{ type: 'android_native', id: 'old', user_id: 'owner', device_id: 'android-device-12345678',
    user_agent: '', label: '', created_at: 1, updated_at: 1 }]) })
  expect(subscribeAndroid).not.toHaveBeenCalled()
})


test('remote Android verifies the relay before sending scoped registration to the backend', async () => {
  transport = 'fcm'; configured = true; relay = true
  await mount()
  expect(current.registrationStatus).toBe('ready')
  await act(async () => { expect(await current.subscribe()).toBe(true) })
  expect(pendingPolls).toBe(1)
  expect(actions).toContain('notifications.poll')
  expect(subscribeAndroid).toHaveBeenCalledTimes(1)
  expect(subscribeAndroid.mock.calls[0]?.[0]).toMatchObject({ delivery: 'relay', relayCredential: 'scoped-delivery-credential', enrollmentId: 'relay-enrollment' })
  expect(subscribeAndroid.mock.calls[0]?.[0]).not.toHaveProperty('deviceToken')
  expect(current.isSubscribed).toBe(true)
})

test('an APK without relay capability shows an update requirement before enrollment', async () => {
  transport = 'fcm'; configured = true; relay = true; relayAvailable = false
  await mount()
  expect(current.registrationReason).toContain('Update the Lumiverse Android app')
  await expect(current.subscribe()).rejects.toThrow('Update')
  expect(subscribeAndroid).not.toHaveBeenCalled()
})

test('failed backend enrollment cancels the verified pending relay capability', async () => {
  transport = 'fcm'; configured = true; relay = true
  subscribeAndroid.mockRejectedValueOnce(new Error('Server unavailable'))
  await mount()
  await act(async () => { await expect(current.subscribe()).rejects.toThrow('Server unavailable') })
  expect(actions).toContain('notifications.cancel')
  expect(actions).not.toContain('notifications.save')
})

test('unmount cancels pending relay verification without creating a backend destination', async () => {
  transport = 'fcm'; configured = true; relay = true
  await mount()
  let result!: Promise<boolean>
  await act(async () => { result = current.subscribe() })
  await act(async () => root.render(null))
  await expect(result).rejects.toThrow('cancelled')
  expect(actions).toContain('notifications.cancel')
  expect(subscribeAndroid).not.toHaveBeenCalled()
})
