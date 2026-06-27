/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { didMobileQueueHoldReachThreshold } from './mobileQueueHold'

describe('didMobileQueueHoldReachThreshold', () => {
  test('does not treat a quick tap as a hold when the event timestamps are close together', () => {
    expect(didMobileQueueHoldReachThreshold({
      holdStartedAt: 10_000,
      releasedAt: 10_120,
      thresholdMs: 900,
    })).toBe(false)
  })

  test('treats a true long hold as queueable', () => {
    expect(didMobileQueueHoldReachThreshold({
      holdStartedAt: 10_000,
      releasedAt: 10_950,
      thresholdMs: 900,
    })).toBe(true)
  })

  test('rejects invalid or out-of-order timestamps', () => {
    expect(didMobileQueueHoldReachThreshold({
      holdStartedAt: 0,
      releasedAt: 10_950,
      thresholdMs: 900,
    })).toBe(false)

    expect(didMobileQueueHoldReachThreshold({
      holdStartedAt: 11_000,
      releasedAt: 10_950,
      thresholdMs: 900,
    })).toBe(false)
  })
})
