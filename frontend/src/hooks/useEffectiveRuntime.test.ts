import { describe, expect, test } from 'bun:test'
import { chatModeExpectedRevision } from './useEffectiveRuntime'

describe('chat mode override revision contract', () => {
  test('uses zero for the first durable override write', () => {
    expect(chatModeExpectedRevision(null)).toBe(0)
    expect(chatModeExpectedRevision(undefined)).toBe(0)
    expect(chatModeExpectedRevision(null, 5)).toBe(5)
  })

  test('preserves the observed revision for stale-write protection', () => {
    expect(chatModeExpectedRevision({
      mode: 'agentic',
      revision: 7,
      state: 'ready',
    })).toBe(7)
  })
})
