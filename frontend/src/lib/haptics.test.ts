import { afterAll, beforeEach, expect, test } from 'bun:test'
import { playHaptic } from './haptics'

const originals = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let nativeCalls: unknown[], vibrations: number[], fail: boolean
let host: { __LUMIVERSE_MOBILE__: boolean; __LUMIVERSE_PLATFORM__: string; __LUMIVERSE_IOS_NATIVE__: unknown }
beforeEach(() => {
  nativeCalls = []; vibrations = []; fail = false
  host = { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, request(action: string, payload: unknown) {
      nativeCalls.push({ action, payload })
      return fail ? Promise.reject(new Error('Older wrapper')) : Promise.resolve({ played: true })
    } } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { hasAttribute: () => false, getAttribute: () => null } } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { vibrate: (ms: number) => vibrations.push(ms) } })
})
afterAll(() => {
  originals.forEach((descriptor, key) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  })
})
test('iOS gestures reach UIKit without also vibrating through the browser', () => {
  playHaptic('selection')
  playHaptic('impact', 50)
  expect(nativeCalls).toEqual([
    { action: 'haptics.play', payload: { feedback: 'selection' } },
    { action: 'haptics.play', payload: { feedback: 'impact' } },
  ])
  expect(vibrations).toEqual([])
})
test('Android and browser gestures retain their existing vibration durations', () => {
  host.__LUMIVERSE_PLATFORM__ = 'android'
  playHaptic('impact', 50); playHaptic('selection')
  expect(vibrations).toEqual([50, 12])
  expect(nativeCalls).toEqual([])
})
test('older wrappers and blocked browser vibration cannot fail the gesture', async () => {
  fail = true
  expect(() => playHaptic('selection')).not.toThrow()
  await Promise.resolve(); await Promise.resolve()
  host.__LUMIVERSE_PLATFORM__ = 'android'
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { vibrate() { throw new Error('Blocked') } } })
  expect(() => playHaptic('impact')).not.toThrow()
})
