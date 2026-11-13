import { describe, expect, test } from 'bun:test'

import { canOptimisticallyAppendStreamingText } from '@/lib/display-streaming'

describe('canOptimisticallyAppendStreamingText', () => {
  test('accepts ordinary append-only streaming text', () => {
    expect(canOptimisticallyAppendStreamingText('Hello', 'Hello there')).toBe(true)
    expect(canOptimisticallyAppendStreamingText('Hello ', 'Hello world.')).toBe(true)
  })

  test('rejects replacements and truncations', () => {
    expect(canOptimisticallyAppendStreamingText('Hello', 'Hallo')).toBe(false)
    expect(canOptimisticallyAppendStreamingText('Hello', 'Hell')).toBe(false)
  })

  test('holds macro syntax from its first streamed character', () => {
    expect(canOptimisticallyAppendStreamingText('Mood: ', 'Mood: {')).toBe(false)
    expect(canOptimisticallyAppendStreamingText('Mood: {', 'Mood: {{mood}}')).toBe(false)
    expect(canOptimisticallyAppendStreamingText('Hi ', 'Hi <us')).toBe(false)
    expect(canOptimisticallyAppendStreamingText('Hi ', 'Hi <USER>')).toBe(false)
  })

  test('does not treat an already-processed earlier macro as new syntax', () => {
    expect(canOptimisticallyAppendStreamingText('Hi {{user}}', 'Hi {{user}}, welcome')).toBe(true)
  })
})
