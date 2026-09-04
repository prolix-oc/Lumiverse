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

  test('does not adjust when regeneration initially shrinks an unpinned row across the viewport top', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: -420,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: true,
    })).toBe(false)
  })

  test('does not adjust an unpinned viewport inside a replaced swipe variant', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: -240,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isSwipeVariantChange: true,
    })).toBe(false)
  })

  test('keeps compensation when a replaced swipe is wholly above the viewport', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: -240,
      itemStart: 800,
      itemEnd: 1100,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isSwipeVariantChange: true,
    })).toBe(true)
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

  test('skips remeasurement compensation during active backward scrolling', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 48,
      itemStart: 1200,
      itemEnd: 1300,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      isScrolling: true,
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
    })).toBe(false)
  })

  test('preserves a settled viewport when the last direction was backward', () => {
    const input = {
      itemStart: 900,
      itemEnd: 1200,
      scrollOffset: 1350,
      scrollDirection: 'backward' as const,
      isScrolling: false,
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
    }

    expect(shouldAdjustMessageListScrollOnResize({ ...input, delta: 240 })).toBe(true)
    expect(shouldAdjustMessageListScrollOnResize({ ...input, delta: -180 })).toBe(true)
  })

  test('preserves the viewport for programmatic content reflow while scrolling backward', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 420,
      itemStart: 900,
      itemEnd: 1200,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isProgrammaticContentReflow: true,
    })).toBe(true)
  })

  test('does not compensate programmatic reflow below the viewport anchor', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 420,
      itemStart: 1400,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isProgrammaticContentReflow: true,
    })).toBe(false)
  })

  test('keeps the unpinned streaming-tail exception during programmatic reflow', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: 180,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'backward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: true,
      isProgrammaticContentReflow: true,
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

  test('does not compensate remeasurement of a user-toggled collapsible row', () => {
    expect(shouldAdjustMessageListScrollOnResize({
      delta: -180,
      itemStart: 1200,
      itemEnd: 1700,
      scrollOffset: 1350,
      scrollDirection: 'forward',
      hasMeasuredSize: true,
      isPinned: false,
      isStreamingTail: false,
      isUserToggledCollapsibleRow: true,
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
