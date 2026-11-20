/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { getSaturationValueFromPoint } from './colorPickerMath'

describe('getSaturationValueFromPoint', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 }

  test('snaps the far-left saturation edge to grayscale', () => {
    expect(getSaturationValueFromPoint(10, 20, rect)).toEqual({ saturation: 0, value: 100 })
    expect(getSaturationValueFromPoint(13, 70, rect)).toEqual({ saturation: 0, value: 50 })
  })

  test('preserves normal saturation selection outside the edge snap zone', () => {
    expect(getSaturationValueFromPoint(20, 70, rect)).toEqual({ saturation: 5, value: 50 })
    expect(getSaturationValueFromPoint(110, 70, rect)).toEqual({ saturation: 50, value: 50 })
  })

  test('clamps out-of-bounds pointer coordinates', () => {
    expect(getSaturationValueFromPoint(0, 10, rect)).toEqual({ saturation: 0, value: 100 })
    expect(getSaturationValueFromPoint(250, 150, rect)).toEqual({ saturation: 100, value: 0 })
  })
})
