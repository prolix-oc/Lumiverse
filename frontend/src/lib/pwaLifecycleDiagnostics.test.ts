/// <reference types="bun-types" />

import { afterAll, describe, expect, test } from 'bun:test'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

const listeners = new Map<string, Array<(event: Event) => void>>()
const storage = new Map<string, string>()

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    matchMedia: () => ({ matches: true }),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const registered = listeners.get(type) ?? []
      registered.push(listener)
      listeners.set(type, registered)
    },
  },
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const registered = listeners.get(type) ?? []
      registered.push(listener)
      listeners.set(type, registered)
    },
  },
})
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {},
})
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { getEntriesByType: () => [{ type: 'reload' }] },
})
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
})
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { randomUUID: () => 'test-session' },
})

const { getPwaLifecycleDiagnostics, installPwaLifecycleDiagnostics } = await import('./pwaLifecycleDiagnostics')

afterAll(() => {
  for (const [key, descriptor] of [
    ['window', originalWindow],
    ['document', originalDocument],
    ['navigator', originalNavigator],
    ['performance', originalPerformance],
    ['localStorage', originalLocalStorage],
    ['crypto', originalCrypto],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
})

describe('PWA lifecycle diagnostics', () => {
  test('persists a boot and terminal lifecycle event for the next app launch', () => {
    installPwaLifecycleDiagnostics()
    listeners.get('pagehide')?.[0]({ type: 'pagehide', persisted: false } as PageTransitionEvent)

    expect(getPwaLifecycleDiagnostics()).toEqual([
      expect.objectContaining({
        event: 'boot',
        session: 'test-session',
        data: expect.objectContaining({ navigation: 'reload' }),
      }),
      expect.objectContaining({
        event: 'pagehide',
        session: 'test-session',
        data: expect.objectContaining({ persisted: false }),
      }),
    ])
  })
})
