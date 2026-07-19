/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { snapRangeValue } from './rangeSliderMath'

describe('snapRangeValue', () => {
  test('snaps odd dimensions to the nearest even value', () => {
    expect(snapRangeValue(513, { min: 256, max: 2048, step: 2, integer: true })).toBe(514)
    expect(snapRangeValue(1023, { min: 256, max: 2048, step: 2, integer: true })).toBe(1024)
  })

  test('snaps off-grid dimensions back to the nearest 64px bucket', () => {
    expect(snapRangeValue(513, { min: 256, max: 2048, step: 64, integer: true })).toBe(512)
    expect(snapRangeValue(545, { min: 256, max: 2048, step: 64, integer: true })).toBe(576)
  })

  test('clamps values back inside the slider bounds', () => {
    expect(snapRangeValue(20, { min: 64, max: 4096, step: 64, integer: true })).toBe(64)
    expect(snapRangeValue(5000, { min: 64, max: 4096, step: 64, integer: true })).toBe(4096)
  })
})
