import { describe, expect, test } from 'bun:test'
import {
  eligibleSummaryMessageCount,
  normalizeSummaryMessageLag,
  shouldAutoSummarize,
} from './scheduling'

describe('summary message lag scheduling', () => {
  test('waits for the lagged tail and measures cadence against eligible messages', () => {
    expect(shouldAutoSummarize(11, 0, 10, 2)).toBe(false)
    expect(shouldAutoSummarize(12, 0, 10, 2)).toBe(true)

    // The first summary covered the prefix through message 10. Messages 11-12
    // remain buffered, then roll into the next eligible ten-message window.
    expect(shouldAutoSummarize(21, 10, 10, 2)).toBe(false)
    expect(shouldAutoSummarize(22, 10, 10, 2)).toBe(true)
  })

  test('preserves the previous cadence when lag is disabled', () => {
    expect(shouldAutoSummarize(9, 0, 10, 0)).toBe(false)
    expect(shouldAutoSummarize(10, 0, 10, 0)).toBe(true)
    expect(shouldAutoSummarize(20, 10, 10, 0)).toBe(true)
  })

  test('normalizes invalid lag values and never exposes a negative eligible count', () => {
    expect(normalizeSummaryMessageLag(-4)).toBe(0)
    expect(normalizeSummaryMessageLag(2.9)).toBe(2)
    expect(eligibleSummaryMessageCount(1, 5)).toBe(0)
  })
})
