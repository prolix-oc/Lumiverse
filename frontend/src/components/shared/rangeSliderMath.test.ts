/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { nearestNumericRangeHandle, snapNumericRange, snapRangeValue, updateNumericRange } from './rangeSliderMath'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LabeledDualRangeSlider } from './RangeSlider'

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

describe('numeric range helpers', () => {
  const options = { min: 0, max: 100, step: 5 }

  test('snaps and orders both endpoints', () => {
    expect(snapNumericRange([82, 13], options)).toEqual([15, 80])
  })

  test('keeps the active endpoint from crossing the other endpoint', () => {
    expect(updateNumericRange([20, 60], 0, 75, options)).toEqual([60, 60])
    expect(updateNumericRange([20, 60], 1, 5, options)).toEqual([20, 20])
  })

  test('selects the nearest handle and resolves an overlap by pointer direction', () => {
    expect(nearestNumericRangeHandle([20, 60], 28)).toBe(0)
    expect(nearestNumericRangeHandle([20, 60], 52)).toBe(1)
    expect(nearestNumericRangeHandle([40, 40], 39)).toBe(0)
    expect(nearestNumericRangeHandle([40, 40], 41)).toBe(1)
  })
})

describe('LabeledDualRangeSlider DOM interaction', () => {
  test('commits keyboard, touch, and pointer adjustments using updated bounds and steps', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    })
    const domWindow = dom.window as unknown as Window & typeof globalThis
    const globalObject = globalThis as unknown as Record<string, unknown>
    const saved: Record<string, unknown> = {
      window: globalObject.window,
      document: globalObject.document,
      Element: globalObject.Element,
      HTMLElement: globalObject.HTMLElement,
      Node: globalObject.Node,
      KeyboardEvent: globalObject.KeyboardEvent,
      IS_REACT_ACT_ENVIRONMENT: globalObject.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.defineProperty(domWindow, 'event', { configurable: true, value: undefined, writable: true })
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      Element: domWindow.Element,
      HTMLElement: domWindow.HTMLElement,
      Node: domWindow.Node,
      KeyboardEvent: domWindow.KeyboardEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let committed: [number, number] = [20, 80]
    let bounds = { min: 0, max: 100, step: 5 }
    const render = () => {
      act(() => {
        root.render(
          createElement(LabeledDualRangeSlider, {
            label: 'Temperature Window',
            ...bounds,
            value: committed,
            formatValue: ([start, end]) => `${start}% – ${end}%`,
            startLabel: 'Window start',
            endLabel: 'Window end',
            onCommit: (next) => {
              committed = next
              render()
            },
          }),
        )
      })
    }

    try {
      render()
      const sliders = host.querySelectorAll<HTMLElement>('[role="slider"]')
      expect(sliders.length).toBe(2)
      expect(host.textContent).toContain('20% – 80%')

      act(() => {
        sliders[0]!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      expect(committed).toEqual([25, 80])

      act(() => {
        sliders[1]!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      })
      expect(committed).toEqual([25, 75])

      act(() => {
        sliders[0]!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      })
      expect(committed).toEqual([75, 75])
      expect(host.textContent).toContain('75% – 75%')

      bounds = { min: 10, max: 210, step: 20 }
      committed = [30, 170]
      render()
      const track = sliders[0]!.parentElement!.parentElement!
      track.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
      track.setPointerCapture = () => {}
      track.releasePointerCapture = () => {}
      const touch = (type: string, clientX: number) => {
        const event = new domWindow.Event(type, { bubbles: true, cancelable: true })
        Object.assign(event, {
          touches: type === 'touchend' ? [] : [{ clientX, clientY: 0 }],
          changedTouches: [{ clientX, clientY: 0 }],
        })
        act(() => { track.dispatchEvent(event) })
      }
      touch('touchstart', 10)
      touch('touchmove', 23)
      expect(host.textContent).toContain('50% – 170%')
      touch('touchend', 23)
      expect(committed).toEqual([50, 170])

      committed = [70, 190]
      render()
      expect(host.textContent).toContain('70% – 190%')
      const pointer = async (type: string, clientX: number) => {
        const event = new domWindow.MouseEvent(type, { clientX, bubbles: true, cancelable: true })
        Object.assign(event, { pointerId: 1, pointerType: 'mouse' })
        await act(async () => { track.dispatchEvent(event) })
      }
      await pointer('pointerdown', 40)
      await pointer('pointermove', 65)
      expect(host.textContent).toContain('150% – 190%')
      await pointer('pointerup', 65)
      expect(committed).toEqual([150, 190])
    } finally {
      act(() => root.unmount())
      host.remove()
      Object.assign(globalObject, saved)
      dom.window.close()
    }
  })
})
