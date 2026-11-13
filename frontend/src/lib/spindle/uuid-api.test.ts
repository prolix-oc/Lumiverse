import { describe, expect, spyOn, test } from 'bun:test'
import { uuidv7 } from '../uuid'
import { createFrontendUUIDAPI, SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES } from './uuid-api'

const pattern = (version: 4 | 7) => new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

describe('frontend UUID API', () => {
  test('returns synchronous UUIDs without the secure-context-only randomUUID API', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: entropy } })
    try {
      const api = createFrontendUUIDAPI(() => {})
      const ids = Array.from({ length: 256 }, () => [api.v4(), api.v7()]).flat()
      expect(new Set(ids).size).toBe(ids.length)
      for (const [index, id] of ids.entries()) {
        expect(typeof id).toBe('string')
        expect(id).toMatch(pattern(index % 2 ? 7 : 4))
      }
      expect(Object.isFrozen(api)).toBe(true)
      expect(SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES).toEqual({ 'frontend-uuid-v1': 1 })
      expect(Object.isFrozen(SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES)).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }
  })

  test('shares the core frontend v7 counter across extension instances', () => {
    const timestamp = 1_793_400_000_000
    const now = spyOn(Date, 'now').mockReturnValue(timestamp)
    try {
      const first = createFrontendUUIDAPI(() => {})
      const second = createFrontendUUIDAPI(() => {})
      const ids = [uuidv7(), first.v7(), second.v7(), uuidv7()]
      expect(ids).toEqual([...ids].sort())
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(id).toMatch(pattern(7))
        expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp)
      }
    } finally {
      now.mockRestore()
    }
  })

  test('captured methods reject stale contexts and fresh instances remain usable', () => {
    let active = true
    const api = createFrontendUUIDAPI(() => { if (!active) throw new Error('Extension unloaded') })
    const captured = api.v4
    expect(captured()).toMatch(pattern(4))
    active = false
    const entropy = spyOn(crypto, 'getRandomValues')
    try {
      expect(() => captured()).toThrow('Extension unloaded')
      expect(() => api.v7()).toThrow('Extension unloaded')
      expect(entropy).not.toHaveBeenCalled()
      expect(createFrontendUUIDAPI(() => {}).v4()).toMatch(pattern(4))
    } finally {
      entropy.mockRestore()
    }
  })
})
