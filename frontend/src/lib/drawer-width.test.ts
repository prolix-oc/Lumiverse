import { describe, expect, test } from 'bun:test'
import { clampDrawerWidth, drawerWidthFromDelta } from './drawer-width'

describe('drawer resizing', () => {
  test('inner edge grows in opposite directions on each side', () => {
    expect(drawerWidthFromDelta(420, -100, 'right', 1, 1920)).toBe(520)
    expect(drawerWidthFromDelta(420, 100, 'left', 1, 1920)).toBe(520)
  })
  test('converts rendered motion to layout pixels at UI zoom', () => {
    expect(drawerWidthFromDelta(420, -100, 'right', 1.25, 1536)).toBe(500)
  })
  test('keeps narrow and wide drawers within the viewport', () => {
    expect(clampDrawerWidth(10, 1920)).toBe(280)
    expect(clampDrawerWidth(2000, 1920)).toBe(1536)
    expect(clampDrawerWidth(420, 320)).toBe(256)
    expect(clampDrawerWidth(NaN, 1920)).toBe(420)
  })
})
