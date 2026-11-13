import { describe, expect, test } from 'bun:test'
import {
  claimServiceWorkerReload,
  isServiceWorkerReplacement,
  SERVICE_WORKER_RELOAD_GUARD_KEY,
  SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS,
} from './swUpdatePolicy'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(SERVICE_WORKER_RELOAD_GUARD_KEY, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('service-worker update policy', () => {
  test('does not treat a first install as an application update', () => {
    expect(isServiceWorkerReplacement(false, false)).toBe(false)
  })

  test('recognizes replacement workers from either browser signal', () => {
    expect(isServiceWorkerReplacement(true, false)).toBe(true)
    expect(isServiceWorkerReplacement(false, true)).toBe(true)
    expect(isServiceWorkerReplacement(true, true)).toBe(true)
  })

  test('allows one automatic reload and suppresses another during the guard window', () => {
    const storage = memoryStorage()

    expect(claimServiceWorkerReload(storage, 100_000)).toBe(true)
    expect(claimServiceWorkerReload(storage, 100_001)).toBe(false)
  })

  test('allows a later service-worker update to reload normally', () => {
    const storage = memoryStorage('100000')

    expect(claimServiceWorkerReload(
      storage,
      100_000 + SERVICE_WORKER_RELOAD_GUARD_WINDOW_MS,
    )).toBe(true)
  })

  test('fails closed when a durable reload guard cannot be recorded', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('storage unavailable') },
    }

    expect(claimServiceWorkerReload(storage, 100_000)).toBe(false)
  })
})
