/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { shouldAdjustMessageListScrollOnResize } from './messageListScrollAdjust'

describe('shouldAdjustMessageListScrollOnResize', () => {
  test('does not adjust when an unpinned streaming tail grows across the viewport top', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: true,
    })).toBe(false)
  })

  test('keeps the default adjustment for non-streaming rows above the viewport', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
    })).toBe(true)
  })

  test('preserves first-measurement compensation while scrolling backward', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1300,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      hasMeasuredSize: false,
      isPinned: false,
      isStreamingTail: false,
    })).toBe(true)
  })

  test('skips remeasurement compensation while scrolling backward', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1300,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
    })).toBe(false)
  })

  test('does not compensate remeasurement of the focused editable row', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isFocusedEditableRow: true,
    })).toBe(false)
  })

  test('keeps first-measure compensation when the editable row initially mounts', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 320,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: false,
      isPinned: false,
      isStreamingTail: false,
      isFocusedEditableRow: true,
    })).toBe(true)
  })
})
