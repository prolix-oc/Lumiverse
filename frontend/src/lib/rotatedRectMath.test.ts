import { describe, expect, test } from 'bun:test'
import { clampRectToBounds, resizeRectFromHandle, resizeRectFromScreenDelta, toLocalDelta } from './rotatedRectMath'

describe('rotated rectangle math', () => {
  test('maps a downward screen drag to local east at 90 degrees', () => { expect(toLocalDelta(0, 100, 90).dx).toBeCloseTo(100) })
  test('preserves aspect and clamps a resized rectangle', () => {
    expect(resizeRectFromHandle({ x: 0, y: 0, width: 80, height: 40 }, 'se', { dx: 40, dy: 0 }, { aspectRatio: 2, bounds: { x: 0, y: 0, width: 100, height: 100 } })).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(clampRectToBounds({ x: 90, y: 90, width: 40, height: 40 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 60, y: 60, width: 40, height: 40 })
  })
  test('inverts both axes at 180 degrees so resize must not use toLocalDelta', () => {
    expect(toLocalDelta(16, 24, 180)).toEqual({ dx: expect.closeTo(-16), dy: expect.closeTo(-24) })
    expect(toLocalDelta(16, 24, -180)).toEqual({ dx: expect.closeTo(-16), dy: expect.closeTo(-24) })
  })
  test('move at 180 degrees adds screen dx so x increases', () => {
    const start = { x: 40, y: 40, width: 80, height: 50 }
    const dx = 10
    expect(start.x + dx).toBe(50)
    expect(start.x + toLocalDelta(dx, 0, 180).dx).toBeLessThan(start.x)
  })
  test('screen drag south at 180 degrees increases height', () => {
    const start = { x: 40, y: 40, width: 80, height: 50 }
    const next = resizeRectFromScreenDelta(start, 's', { dx: 0, dy: 20 }, 180)
    expect(next.height).toBe(70)
    expect(next.height).toBeGreaterThan(start.height)
    expect(resizeRectFromHandle(start, 's', toLocalDelta(0, 20, 180)).height).toBeLessThan(start.height)
  })
  test('screen drag east at 180 degrees increases width', () => {
    const start = { x: 40, y: 40, width: 80, height: 50 }
    const next = resizeRectFromScreenDelta(start, 'e', { dx: 20, dy: 0 }, 180)
    expect(next.width).toBe(100)
    expect(next.width).toBeGreaterThan(start.width)
    expect(resizeRectFromHandle(start, 'e', toLocalDelta(20, 0, 180)).width).toBeLessThan(start.width)
  })
  test('screen drag south and east at -180 degrees still grow the box', () => {
    const start = { x: 40, y: 40, width: 80, height: 50 }
    expect(resizeRectFromScreenDelta(start, 's', { dx: 0, dy: 20 }, -180).height).toBe(70)
    expect(resizeRectFromScreenDelta(start, 'e', { dx: 20, dy: 0 }, -180).width).toBe(100)
  })
})
