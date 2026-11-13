/// <reference types="bun-types" />

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  clampDrawerTabVerticalPosition,
  drawerTabPositionFromRenderedDelta,
  useDrawerTabDrag,
} from './useDrawerTabDrag'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  PointerEvent: dom.window.PointerEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 1000 })
  if (!dom.window.HTMLElement.prototype.setPointerCapture) {
    dom.window.HTMLElement.prototype.setPointerCapture = () => undefined
  }
  if (!dom.window.HTMLElement.prototype.hasPointerCapture) {
    dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!dom.window.HTMLElement.prototype.releasePointerCapture) {
    dom.window.HTMLElement.prototype.releasePointerCapture = () => undefined
  }
})

afterEach(() => {
  document.body.replaceChildren()
  document.documentElement.style.removeProperty('--lumiverse-ui-scale')
})

function pointer(type: string, x: number, y: number, pointerId = 1) {
  return new dom.window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
    isPrimary: true,
    pointerId,
  })
}

function renderProbe(initialPosition = 15, initiallyOpen = false) {
  const commits: number[] = []
  let open = initiallyOpen

  function Probe() {
    const drag = useDrawerTabDrag({
      position: commits.at(-1) ?? initialPosition,
      onCommit: (position) => commits.push(position),
    })
    return (
      <button
        type="button"
        data-position={drag.verticalPosition}
        data-dragging={drag.isDragging ? 'true' : 'false'}
        onClick={(event) => {
          if (!drag.consumeSuppressedClick(event)) open = !open
        }}
        {...drag.pointerHandlers}
      />
    )
  }

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(<Probe />))
  return {
    button: host.querySelector('button')!,
    commits,
    isOpen: () => open,
    unmount: () => act(() => root.unmount()),
  }
}

describe('drawer tab vertical drag', () => {
  test('clamps to the slider range and compensates for UI scale', () => {
    expect(clampDrawerTabVerticalPosition(-10)).toBe(0)
    expect(clampDrawerTabVerticalPosition(99)).toBe(70)
    expect(drawerTabPositionFromRenderedDelta(15, 200, 1000, 1)).toBe(35)
    expect(drawerTabPositionFromRenderedDelta(15, 200, 1000, 2)).toBe(25)
  })

  test('keeps taps and sub-threshold movement as ordinary drawer clicks', () => {
    const probe = renderProbe()
    try {
      act(() => {
        probe.button.dispatchEvent(pointer('pointerdown', 10, 100))
        probe.button.dispatchEvent(pointer('pointermove', 12, 103))
        probe.button.dispatchEvent(pointer('pointerup', 12, 103))
        probe.button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(probe.isOpen()).toBe(true)
      expect(probe.commits).toEqual([])
    } finally {
      probe.unmount()
    }
  })

  test('commits one position and consumes the click after dragging while closed', () => {
    const probe = renderProbe(15, false)
    try {
      act(() => {
        probe.button.dispatchEvent(pointer('pointerdown', 10, 100))
        probe.button.dispatchEvent(pointer('pointermove', 10, 300))
      })
      expect(probe.button.dataset.position).toBe('35')
      expect(probe.button.dataset.dragging).toBe('true')

      act(() => {
        probe.button.dispatchEvent(pointer('pointerup', 10, 300))
        probe.button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(probe.commits).toEqual([35])
      expect(probe.isOpen()).toBe(false)
    } finally {
      probe.unmount()
    }
  })

  test('does not close an open drawer after dragging and clamps at 70 percent', () => {
    const probe = renderProbe(65, true)
    try {
      act(() => {
        probe.button.dispatchEvent(pointer('pointerdown', 10, 100))
        probe.button.dispatchEvent(pointer('pointermove', 10, 900))
        probe.button.dispatchEvent(pointer('pointerup', 10, 900))
        probe.button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(probe.commits).toEqual([70])
      expect(probe.isOpen()).toBe(true)
    } finally {
      probe.unmount()
    }
  })

  test('commits the latest valid position when pointer capture is cancelled', () => {
    const probe = renderProbe(15)
    try {
      act(() => {
        probe.button.dispatchEvent(pointer('pointerdown', 10, 100))
        probe.button.dispatchEvent(pointer('pointermove', 10, -400))
        probe.button.dispatchEvent(pointer('pointercancel', 10, -400))
      })
      expect(probe.commits).toEqual([0])
      expect(probe.button.dataset.dragging).toBe('false')
    } finally {
      probe.unmount()
    }
  })
})
