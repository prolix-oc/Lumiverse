import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { PushSubscriptionRecord } from '@/api/push'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test' })
const globals = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
})
Object.defineProperty(dom.window, '__LUMIVERSE_MOBILE__', { value: true })
Object.defineProperty(dom.window, '__LUMIVERSE_PLATFORM__', { value: 'ios' })
let configured = true, available = true
let delivery: 'direct' | 'relay' = 'direct', relayAvailable = true
let rows: PushSubscriptionRecord[] = []
const registration = { deviceId: 'ios-device-12345678', deviceToken: 'ab'.repeat(32), bundleId: 'chat.lumiverse.ios', environment: 'development' }
const request = mock(async (action: string, _payload?: Record<string, unknown>) => {
  if (action === 'notifications.status') return { ...registration, available, relayAvailable, permission: 'default', reason: available ? null : 'IPA needs push signing' }
  if (action === 'notifications.register') return registration
  throw new Error('Unknown native action')
})
Object.defineProperty(dom.window, '__LUMIVERSE_IOS_NATIVE__', { value: { version: 1, request } })
const subscribeIOS = mock(async () => {
  const row = { type: 'ios_apns' as const, id: 'ios-destination', user_id: 'user', device_id: registration.deviceId,
    bundle_id: registration.bundleId, environment: 'development' as const, user_agent: '', label: 'Lumiverse iOS', created_at: 1, updated_at: 1 }
  rows = [row]; return row
})
const unsubscribe = mock(async () => { rows = [] })
const testPush = mock(async () => ({ success: true, sent: 1 }))
mock.module('@/api/push', () => ({ pushApi: {
  getIOSInfo: async () => ({ configured, bundleId: registration.bundleId, delivery,
    ...(delivery === 'relay' ? { relayUrl: 'https://apn-relay.lumiverse.chat' } : {}), reason: configured ? null : 'Server needs an APNs provider key' }),
  listSubscriptions: async () => rows, subscribeIOS, unsubscribe, test: testPush,
  getVapidPublicKey: () => { throw new Error('iOS must not request a browser key') },
} }))
const { usePushSubscription } = await import('./usePushSubscription')
let current!: ReturnType<typeof usePushSubscription>, root: Root
function Fixture() {
  const subscription = usePushSubscription()
  useEffect(() => { current = subscription }, [subscription])
  return null
}
beforeEach(async () => {
  configured = true; available = true; delivery = 'direct'; relayAvailable = true; rows = []
  request.mockClear(); subscribeIOS.mockClear(); unsubscribe.mockClear(); testPush.mockClear()
  root = createRoot(document.createElement('div'))
})
afterEach(async () => { await act(async () => root.unmount()) })
afterAll(() => {
  dom.window.close()
  for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  mock.restore()
})
const mount = () => act(async () => { root.render(createElement(Fixture)) })

test('iOS enrolls, tests, and removes its native destination without browser push APIs', async () => {
  await mount()
  expect(current.isSupported).toBe(true)
  expect(current.registrationKind).toBe('native')
  expect(current.registrationStatus).toBe('ready')
  await act(async () => { expect(await current.subscribe()).toBe(true) })
  expect(subscribeIOS).toHaveBeenCalledWith(registration)
  expect(current.isSubscribed).toBe(true)
  await current.testPush()
  expect(testPush).toHaveBeenCalledWith('ios-destination')
  await act(async () => current.unsubscribe('ios-destination'))
  expect(current.isSubscribed).toBe(false)
  expect(unsubscribe).toHaveBeenCalledWith('ios-destination')
})

test('missing provider credentials show a native setup error instead of browser unsupported', async () => {
  configured = false
  await mount()
  expect(current.isSupported).toBe(true)
  expect(current.registrationStatus).toBe('error')
  expect(current.registrationReason).toContain('APNs provider key')
  await expect(current.subscribe()).rejects.toThrow('APNs provider key')
  expect(request.mock.calls.every(([action]) => action === 'notifications.status' || action === 'lifecycle.status')).toBe(true)
})

test('Personal Team builds report missing app signing before attempting registration', async () => {
  available = false
  await mount()
  expect(current.isSupported).toBe(true)
  expect(current.registrationReason).toBe('IPA needs push signing')
  await expect(current.subscribe()).rejects.toThrow('IPA needs push signing')
  expect(subscribeIOS).not.toHaveBeenCalled()
})

test('relay enrollment explicitly selects the native verification flow and older IPAs fail with an update message', async () => {
  delivery = 'relay'
  await mount()
  expect(current.registrationStatus).toBe('ready')
  await act(async () => { await current.subscribe() })
  expect(request).toHaveBeenCalledWith('notifications.register', { delivery: 'relay', relayUrl: 'https://apn-relay.lumiverse.chat' })
  relayAvailable = false
  await act(async () => { await current.refresh() })
  expect(current.registrationReason).toContain('Update the iOS app')
})

test('native activation refreshes notification readiness while WebKit still reports hidden', async () => {
  configured = false
  await mount()
  expect(current.registrationStatus).toBe('error')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  try {
    configured = true
    await act(async () => {
      window.dispatchEvent(new dom.window.CustomEvent('lumiverse:ios-app-state', { detail: { state: 'active' } }))
    })
    expect(current.registrationStatus).toBe('ready')
  } finally { Reflect.deleteProperty(document, 'visibilityState') }
})
