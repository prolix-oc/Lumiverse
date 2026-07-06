/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { shouldPinMessageListTail } from './messageListPinning'

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
