import { afterAll, beforeEach, expect, test } from 'bun:test'
import { IOSSpeechEngine } from './ios-speech'

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
const secureRandom = crypto.getRandomValues.bind(crypto)
let host: EventTarget & { __LUMIVERSE_MOBILE__: boolean; __LUMIVERSE_PLATFORM__: string; __LUMIVERSE_IOS_NATIVE__: unknown }
let calls: Array<{ action: string; payload?: Record<string, unknown> }>
let begin: () => void
const config = { provider: 'webspeech' as const, language: 'en-US', continuous: true, interimResults: true }
beforeEach(() => {
  calls = []
  host = Object.assign(new EventTarget(), { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, request(action: string, payload?: Record<string, unknown>) {
      calls.push({ action, payload })
      return action === 'speech.start' ? new Promise(resolve => { begin = () => resolve({ started: true }) }) : Promise.resolve({})
    } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { hasAttribute: () => false, getAttribute: () => null } } })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: secureRandom } })
})
afterAll(() => {
  for (const [key, value] of [['window', previousWindow], ['document', previousDocument], ['crypto', previousCrypto]] as const) {
    if (value) Object.defineProperty(globalThis, key, value)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const emit = (detail: unknown) => host.dispatchEvent(Object.assign(new Event('lumiverse:ios-speech'), { detail }))

test('routes native recognition results to the correct session and finishes once', async () => {
  const engine = new IOSSpeechEngine(config), results: unknown[] = []
  let ended = 0
  engine.onResult(result => results.push(result)); engine.onStop(() => ended++)
  const startup = engine.start(), id = calls[0]!.payload!.id
  begin(); await startup
  emit({ id: 'other-session', type: 'result', text: 'wrong', isFinal: true })
  emit({ id, type: 'result', text: 'Hello', isFinal: false })
  engine.stop()
  expect(calls[1]).toEqual({ action: 'speech.stop', payload: { id } })
  emit({ id, type: 'result', text: 'Hello world', isFinal: true })
  emit({ id, type: 'end' }); emit({ id, type: 'end' })
  expect(results).toEqual([{ text: 'Hello', isFinal: false }, { text: 'Hello world', isFinal: true }])
  expect(ended).toBe(1); expect(engine.isListening()).toBe(false)
})

test('cancelling while authorization is pending suppresses late startup and transcripts', async () => {
  const engine = new IOSSpeechEngine(config)
  let results = 0, listening = 0
  engine.onResult(() => results++); engine.onStatus(() => listening++)
  const startup = engine.start(), id = calls[0]!.payload!.id
  engine.destroy(); begin(); await startup
  emit({ id, type: 'result', text: 'late', isFinal: true })
  expect(calls[1]).toEqual({ action: 'speech.cancel', payload: { id } })
  expect(results).toBe(0); expect(listening).toBe(0); expect(engine.isListening()).toBe(false)
})

test('page navigation cancels the native microphone session', async () => {
  const engine = new IOSSpeechEngine(config)
  const startup = engine.start(); begin(); await startup
  host.dispatchEvent(new Event('pagehide'))
  expect(calls.at(-1)?.action).toBe('speech.cancel')
  expect(engine.isListening()).toBe(false)
})
