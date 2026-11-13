import { afterEach, describe, expect, test } from 'bun:test'
import { getWhistleUnavailableReason, isWhistleAvailable, type WhistleUnavailableReason } from './config'

const names = ['window', 'navigator', 'Worker', 'WebAssembly', 'BigInt', 'crypto', 'AudioWorkletNode'] as const
const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
const replace = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, value })

function supported() {
  replace('window', { isSecureContext: true, AudioContext: class { createScriptProcessor() {} } })
  replace('navigator', { mediaDevices: { getUserMedia: () => {} } })
  replace('Worker', class {})
  replace('WebAssembly', {})
  replace('BigInt', () => {})
  replace('crypto', { subtle: {} })
  replace('AudioWorkletNode', class {})
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

describe('Whistle webview capability detection', () => {
  test('accepts worklet and legacy capture without browser-name detection', () => {
    supported()
    expect(isWhistleAvailable()).toBe(true)
    replace('AudioWorkletNode', undefined)
    expect(isWhistleAvailable()).toBe(true)
    ;(window as any).webkitAudioContext = window.AudioContext
    ;(window as any).AudioContext = undefined
    expect(isWhistleAvailable()).toBe(true)
  })

  test('identifies an insecure origin before its missing microphone and crypto APIs', () => {
    supported()
    ;(window as any).isSecureContext = false
    replace('navigator', {})
    replace('crypto', {})
    expect(getWhistleUnavailableReason()).toBe('secureContext')
  })

  const missingApis: [string, unknown, WhistleUnavailableReason][] = [
    ['Worker', undefined, 'worker'],
    ['WebAssembly', undefined, 'wasm'],
    ['BigInt', undefined, 'wasm'],
    ['crypto', {}, 'crypto'],
    ['navigator', {}, 'microphone'],
  ]
  test.each(missingApis)('explains a missing %s API', (name, value, reason) => {
    supported()
    replace(name as string, value)
    expect(getWhistleUnavailableReason()).toBe(reason)
    expect(isWhistleAvailable()).toBe(false)
  })

  test('requires a working capture API and an AudioContext', () => {
    supported()
    replace('AudioWorkletNode', undefined)
    ;(window as any).AudioContext = class {}
    expect(getWhistleUnavailableReason()).toBe('audioCapture')
    replace('AudioWorkletNode', class {})
    ;(window as any).AudioContext = undefined
    expect(getWhistleUnavailableReason()).toBe('audioCapture')
  })
})
