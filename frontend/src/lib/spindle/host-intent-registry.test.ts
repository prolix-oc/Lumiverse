import { afterEach, describe, expect, test } from 'bun:test'
import {
  cloneHostIntentDetail,
  registerHostIntentHandler,
} from './host-intent-registry'

const originalWindow = globalThis.window
const eventTarget = new EventTarget()
const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

function installTestWindow(): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: eventTarget })
}

function dispatchIntent(detail: unknown): Event {
  const event = new Event('lumiverse:intent:image-preview', { cancelable: true })
  Object.defineProperty(event, 'detail', { configurable: true, value: detail })
  eventTarget.dispatchEvent(event)
  return event
}

describe('PR1 host intent registration', () => {
  test('allows only the claimable name and claims JSON details with preventDefault', () => {
    installTestWindow()
    const seen: unknown[] = []
    const dispose = registerHostIntentHandler('image-preview', (detail) => {
      seen.push(detail)
      return true
    })
    disposers.push(dispose)

    const event = dispatchIntent({ imageId: 'image-1', source: 'message' })
    expect(event.defaultPrevented).toBeTrue()
    expect(seen).toEqual([{ imageId: 'image-1', source: 'message' }])
    dispose()
    expect(dispatchIntent({ imageId: 'image-2' }).defaultPrevented).toBeFalse()
  })

  test('preserves fallback for false, throwing, invalid, and non-allowlisted handlers', () => {
    installTestWindow()
    expect(() => registerHostIntentHandler('delete-confirm', () => true)).toThrow('HOST_INTENT_NOT_CLAIMABLE')
    disposers.push(registerHostIntentHandler('image-preview', () => false))
    disposers.push(registerHostIntentHandler('image-preview', () => { throw new Error('handler failure') }))
    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      expect(dispatchIntent({ imageId: 'image-3' }).defaultPrevented).toBeFalse()
      expect(dispatchIntent({ node: document.createElement('div') }).defaultPrevented).toBeFalse()
    } finally {
      console.error = originalConsoleError
    }
  })

  test('clones only bounded JSON data and rejects DOM, functions, cycles, and non-finite values', () => {
    const source = { nested: { value: 'safe' } }
    const clone = cloneHostIntentDetail(source)
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
    expect(cloneHostIntentDetail({ node: document.createElement('div') })).toBeUndefined()
    expect(cloneHostIntentDetail({ callback: () => undefined })).toBeUndefined()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(cloneHostIntentDetail(cycle)).toBeUndefined()
    expect(cloneHostIntentDetail({ value: Number.NaN })).toBeUndefined()
  })
})
