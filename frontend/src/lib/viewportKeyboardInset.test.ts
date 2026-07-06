/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { computeViewportKeyboardInset } from './viewportKeyboardInset'

describe('computeViewportKeyboardInset', () => {
  test('clears a stale reduced viewport once editable focus is gone', () => {
    expect(computeViewportKeyboardInset({
      fullHeight: 844,
      viewportHeight: 520,
      offsetTop: 0,
      keyboardActive: false,
    })).toBe(0)
  })

  test('subtracts offsetTop outside iOS standalone PWAs', () => {
    expect(computeViewportKeyboardInset({
      fullHeight: 844,
      viewportHeight: 600,
      offsetTop: 140,
      keyboardActive: true,
    })).toBe(104)
  })

  test('ignores offsetTop when standalone iOS viewport panning is neutralized', () => {
    expect(computeViewportKeyboardInset({
      fullHeight: 844,
      viewportHeight: 600,
      offsetTop: 140,
      keyboardActive: true,
      ignoreOffsetTop: true,
    })).toBe(244)
  })

  test('accepts focused accessory-bar occlusion in iOS standalone PWAs', () => {
    expect(computeViewportKeyboardInset({
      fullHeight: 1024,
      viewportHeight: 970,
      offsetTop: 0,
      keyboardActive: true,
      ignoreOffsetTop: true,
      accessoryMinInset: 44,
    })).toBe(54)
  })

  test('filters tiny focused residual insets that are below the accessory floor', () => {
    expect(computeViewportKeyboardInset({
      fullHeight: 844,
      viewportHeight: 820,
      offsetTop: 0,
      keyboardActive: true,
      ignoreOffsetTop: true,
      accessoryMinInset: 44,
    })).toBe(0)
  })
})
