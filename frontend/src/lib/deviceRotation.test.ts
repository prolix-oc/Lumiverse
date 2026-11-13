import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { doesDeviceRotationNeedPermission, getDeviceRotationSnapshot, isDeviceRotationSupported,
  requestDeviceRotationPermission, subscribeDeviceRotation } from './deviceRotation'

const originals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let dom: JSDOM, stops: (() => void)[], calls: { action: string; payload?: Record<string, unknown> }[]
let request: (action: string, payload?: Record<string, unknown>) => Promise<unknown>
beforeEach(() => {
  dom = new JSDOM('', { url: 'https://server.example', pretendToBeVisual: true })
  stops = []; calls = []
  request = async () => ({ available: true })
  Object.assign(dom.window, { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, deviceMotion: 1, request(action: string, payload?: Record<string, unknown>) {
      calls.push({ action, payload }); return request(action, payload)
    } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
})
afterEach(() => { stops.forEach(stop => stop()); dom.window.close() })
afterAll(() => originals.forEach((descriptor, key) => {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else Reflect.deleteProperty(globalThis, key)
}))
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function nativeEvent(id: unknown, quaternion: unknown, reset = false) {
  const platform = (window as any).__LUMIVERSE_PLATFORM__
  dom.window.dispatchEvent(new dom.window.CustomEvent(`lumiverse:${platform}-device-motion`, { detail: { id, quaternion, reset } }))
}
const q = { x: 0, y: 0, z: 0, w: 1 }

function useAndroid() {
  const native = (window as any).__LUMIVERSE_IOS_NATIVE__
  delete (window as any).__LUMIVERSE_IOS_NATIVE__
  Object.assign(window, { __LUMIVERSE_PLATFORM__: 'android', __LUMIVERSE_ANDROID_MOTION__: native })
}

for (const platform of ['ios', 'android']) {
  test(`${platform} prefers native motion without a browser gesture or HTTPS requirement and shares one stream`, async () => {
    if (platform === 'android') useAndroid()
    Object.defineProperty(window, 'isSecureContext', { value: false })
    expect(isDeviceRotationSupported()).toBe(true)
    expect(doesDeviceRotationNeedPermission()).toBe(false)
    expect(await requestDeviceRotationPermission()).toEqual({ state: 'granted', requiresUserGesture: false })
    const snapshots: unknown[] = []
    const stop = subscribeDeviceRotation(value => snapshots.push(value)); stops.push(stop)
    stops.push(subscribeDeviceRotation(() => {}))
    expect(calls.filter(c => c.action === 'motion.start')).toHaveLength(1)
    const id = calls[0].payload!.id
    nativeEvent('stale', q)
    nativeEvent(id, { ...q, x: NaN })
    nativeEvent(id, { ...q, w: 0 })
    expect(snapshots).toHaveLength(0)
    nativeEvent(id, q, true)
    expect(getDeviceRotationSnapshot()).toMatchObject({ quaternion: q, hasReading: true, permission: 'granted' })
    stop()
    expect(calls.some(c => c.action === 'motion.stop')).toBe(false)
  })

  test(`${platform} stops while hidden, starts a fresh stream on return, and ignores stale events`, () => {
    if (platform === 'android') useAndroid()
    stops.push(subscribeDeviceRotation(() => {}))
    const id = calls[0].payload!.id
    nativeEvent(id, q)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new dom.window.Event('visibilitychange'))
    expect(calls.at(-1)).toEqual({ action: 'motion.stop', payload: { id } })
    expect(getDeviceRotationSnapshot().hasReading).toBe(false)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new dom.window.Event('visibilitychange'))
    const nextID = calls.at(-1)!.payload!.id
    expect(nextID).not.toBe(id)
    nativeEvent(id, q)
    expect(getDeviceRotationSnapshot().hasReading).toBe(false)
    nativeEvent(nextID, q)
    expect(getDeviceRotationSnapshot().hasReading).toBe(true)
  })

  test(`${platform} delayed failed start cannot disable a newer subscription`, async () => {
    if (platform === 'android') useAndroid()
    let rejectOld!: (reason: Error) => void
    request = () => new Promise((_, reject) => { rejectOld = reject })
    const stop = subscribeDeviceRotation(() => {}); stop()
    request = async () => ({ available: true })
    stops.push(subscribeDeviceRotation(() => {}))
    const id = calls.at(-1)!.payload!.id
    rejectOld(new Error('old stream'))
    await flush()
    nativeEvent(id, q)
    expect(getDeviceRotationSnapshot().quaternion).toEqual(q)
    expect(doesDeviceRotationNeedPermission()).toBe(false)
  })
}

test('older Android wrappers keep using browser motion', () => {
  useAndroid()
  delete (window as any).__LUMIVERSE_ANDROID_MOTION__
  stops.push(subscribeDeviceRotation(() => {}))
  window.dispatchEvent(Object.assign(new dom.window.Event('deviceorientation'), { alpha: 0, beta: 65, gamma: 5 }))
  expect(getDeviceRotationSnapshot().orientation).toMatchObject({ beta: 65, gamma: 5 })
  expect(calls).toEqual([])
})

test('older wrappers retain Safari permission requests and browser orientation', async () => {
  delete (window as any).__LUMIVERSE_IOS_NATIVE__.deviceMotion
  Object.defineProperty(window, 'isSecureContext', { value: true })
  let prompts = 0
  Object.assign(window, { DeviceOrientationEvent: { requestPermission: async () => { prompts++; return 'granted' } } })
  expect(doesDeviceRotationNeedPermission()).toBe(true)
  expect((await requestDeviceRotationPermission({ includeMotion: false })).state).toBe('granted')
  expect(prompts).toBe(1)
  stops.push(subscribeDeviceRotation(() => {}))
  window.dispatchEvent(Object.assign(new dom.window.Event('deviceorientation'), { alpha: 0, beta: 65, gamma: 5 }))
  expect(getDeviceRotationSnapshot().orientation).toMatchObject({ beta: 65, gamma: 5 })
  expect(calls).toEqual([])
})

for (const platform of ['ios', 'android']) {
  test(`${platform} unavailable native sensors fall back to the browser and expose the permission affordance`, async () => {
    if (platform === 'android') useAndroid()
    Object.assign(window, { DeviceOrientationEvent: { requestPermission: async () => 'granted' } })
    request = async () => ({ available: false })
    stops.push(subscribeDeviceRotation(() => {}))
    await flush()
    expect(doesDeviceRotationNeedPermission()).toBe(true)
    expect(getDeviceRotationSnapshot().permission).toBe('prompt')
    window.dispatchEvent(Object.assign(new dom.window.Event('deviceorientation'), { alpha: 0, beta: 70, gamma: 2 }))
    expect(getDeviceRotationSnapshot().orientation).toMatchObject({ beta: 70, gamma: 2 })
  })
}
