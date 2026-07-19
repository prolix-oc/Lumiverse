/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { didMobileQueueHoldReachThreshold, getMobileQueueHoldPreviewState } from './mobileQueueHold'

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

describe('getMobileQueueHoldPreviewState', () => {
  test('keeps a quick tap visually idle before the hold preview delay elapses', () => {
    expect(getMobileQueueHoldPreviewState({
      holdStartedAt: 10_000,
      evaluatedAt: 10_120,
      revealAfterMs: 180,
      thresholdMs: 900,
    })).toBe('idle')
  })

  test('reveals holding only after the preview delay and arms at the real queue threshold', () => {
    expect(getMobileQueueHoldPreviewState({
      holdStartedAt: 10_000,
      evaluatedAt: 10_220,
      revealAfterMs: 180,
      thresholdMs: 900,
    })).toBe('holding')

    expect(getMobileQueueHoldPreviewState({
      holdStartedAt: 10_000,
      evaluatedAt: 10_950,
      revealAfterMs: 180,
      thresholdMs: 900,
    })).toBe('armed')
  })

  test('falls back to idle for invalid timestamps', () => {
    expect(getMobileQueueHoldPreviewState({
      holdStartedAt: 0,
      evaluatedAt: 10_220,
      revealAfterMs: 180,
      thresholdMs: 900,
    })).toBe('idle')

    expect(getMobileQueueHoldPreviewState({
      holdStartedAt: 11_000,
      evaluatedAt: 10_220,
      revealAfterMs: 180,
      thresholdMs: 900,
    })).toBe('idle')
  })
})
