import { describe, expect, test } from 'bun:test'
import { isServiceWorkerReplacement } from './swUpdatePolicy'

describe('service-worker update policy', () => {
  test('does not treat a first install as an application update', () => {
    expect(isServiceWorkerReplacement(false, false)).toBe(false)
  })

  test('recognizes replacement workers from either browser signal', () => {
    expect(isServiceWorkerReplacement(true, false)).toBe(true)
    expect(isServiceWorkerReplacement(false, true)).toBe(true)
    expect(isServiceWorkerReplacement(true, true)).toBe(true)
  })
})
