/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { isMessageListScrollRangeClamp, shouldPinMessageListTail } from './messageListPinning'

describe('shouldPinMessageListTail', () => {
  test('treats near-end distance as pinned before the user explicitly unpins', () => {
    expect(shouldPinMessageListTail({
      distanceFromEnd: 48,
      userHasUnpinned: false,
      bottomRepinEpsilon: 80,
    })).toBe(true)
  })

  test('does not re-pin a user-unpinned list while merely near the bottom', () => {
    expect(shouldPinMessageListTail({
      distanceFromEnd: 48,
      userHasUnpinned: true,
      bottomRepinEpsilon: 80,
    })).toBe(false)
  })

  test('re-pins a user-unpinned list only after it returns to the real bottom', () => {
    expect(shouldPinMessageListTail({
      distanceFromEnd: 1,
      userHasUnpinned: true,
      bottomRepinEpsilon: 80,
    })).toBe(true)
  })
})

describe('message list scroll range clamping', () => {
  test('recognizes keyboard padding collapsing at the tail', () => {
    expect(isMessageListScrollRangeClamp(
      { scrollTop: 1500, scrollHeight: 2300, clientHeight: 800 },
      { scrollTop: 1176, scrollHeight: 1976, clientHeight: 800 },
    )).toBe(true)
  })

  test('recognizes viewport growth and clamping a short list to zero', () => {
    expect(isMessageListScrollRangeClamp(
      { scrollTop: 300, scrollHeight: 900, clientHeight: 600 },
      { scrollTop: 0, scrollHeight: 900, clientHeight: 900 },
    )).toBe(true)
  })

  test('keeps ordinary upward scrolling and movement past the new end distinct', () => {
    const previous = { scrollTop: 1500, scrollHeight: 2300, clientHeight: 800 }
    expect(isMessageListScrollRangeClamp(previous,
      { scrollTop: 1400, scrollHeight: 2300, clientHeight: 800 },
    )).toBe(false)
    expect(isMessageListScrollRangeClamp(previous,
      { scrollTop: 1000, scrollHeight: 1976, clientHeight: 800 },
    )).toBe(false)
    expect(isMessageListScrollRangeClamp(null, previous)).toBe(false)
  })
})
