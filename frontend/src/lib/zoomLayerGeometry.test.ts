import { describe, expect, test } from 'bun:test'
import { clampLayoutRect, createResizeController, toLayoutDelta, type LayoutRect } from './zoomLayerGeometry'

class PointerTarget extends EventTarget {
  emit(type: string, pointerId: number, clientX: number, clientY: number) { this.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX, clientY })) }
}

describe('zoom-layer geometry', () => {
  test('converts scale 1, 1.25, and 1.6 deltas', () => {
    expect(toLayoutDelta(125, -50, 1)).toEqual({ x: 125, y: -50 })
    expect(toLayoutDelta(125, -50, 1.25)).toEqual({ x: 100, y: -40 })
    expect(toLayoutDelta(160, -80, 1.6)).toEqual({ x: 100, y: -50 })
  })
  test('honours bounds, minimums, and grid snapping', () => {
    expect(clampLayoutRect({ x: 90, y: 90, width: 5, height: 5 }, { x: 0, y: 0, width: 100, height: 100 }, { minSize: 20 })).toEqual({ x: 80, y: 80, width: 20, height: 20 })
    const target = new PointerTarget(); let rect: LayoutRect = { x: 0, y: 0, width: 40, height: 40 }
    createResizeController({ element: target, pointerTarget: target, edge: 'right', getRect: () => rect, snap: 10, bounds: { x: 0, y: 0, width: 100, height: 100 }, onChange: next => { rect = next } })
    target.emit('pointerdown', 1, 0, 0); target.emit('pointermove', 1, 26, 0)
    expect(rect.width).toBe(70)
  })
})
