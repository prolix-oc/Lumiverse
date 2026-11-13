/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { isLongMessageCollapseEligible } from './longMessageCollapse'

const base = {
  enabled: true,
  isUser: false,
  chatId: 'chat-1',
  messageId: 'message-1',
}

describe('long message collapse depth', () => {
  test('keeps messages newer than the configured depth expanded', () => {
    expect(isLongMessageCollapseEligible({ ...base, depth: 4, collapseDepth: 5 })).toBe(false)
  })

  test('collapses at the configured depth and older', () => {
    expect(isLongMessageCollapseEligible({ ...base, depth: 5, collapseDepth: 5 })).toBe(true)
    expect(isLongMessageCollapseEligible({ ...base, depth: 9, collapseDepth: 5 })).toBe(true)
  })

  test('depth zero preserves the existing collapse behavior', () => {
    expect(isLongMessageCollapseEligible({ ...base, depth: 0, collapseDepth: 0 })).toBe(true)
    expect(isLongMessageCollapseEligible(base)).toBe(true)
  })

  test('opted-in user messages respect depth, enablement and identity', () => {
    const user = { ...base, isUser: true, includeUserMessages: true, collapseDepth: 5 }
    expect(isLongMessageCollapseEligible({ ...user, depth: 4 })).toBe(false)
    expect(isLongMessageCollapseEligible({ ...user, depth: 5 })).toBe(true)
    expect(isLongMessageCollapseEligible({ ...user, depth: 20 })).toBe(true)
    expect(isLongMessageCollapseEligible({ ...user, depth: 20, enabled: false })).toBe(false)
    expect(isLongMessageCollapseEligible({ ...user, depth: 20, chatId: undefined })).toBe(false)
    expect(isLongMessageCollapseEligible({ ...user, depth: 20, messageId: undefined })).toBe(false)
  })

  test('still excludes user messages', () => {
    expect(isLongMessageCollapseEligible({ ...base, isUser: true, depth: 20, collapseDepth: 5 })).toBe(false)
  })
})
