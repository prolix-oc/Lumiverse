import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { installIOSTouchScrollGuard, isStylusTouchEvent, preventPageTouchZoom } from './iosTouchScroll'

const dom = new JSDOM('<!doctype html><body></body>')
const originals = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element }
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element })
const viewport = { scale: 1 }
Object.defineProperty(window, 'visualViewport', { value: viewport })
let stop: () => void
let target: HTMLElement
beforeEach(() => {
  viewport.scale = 1
  target = document.createElement('button')
  document.body.append(target)
  document.addEventListener('touchmove', preventPageTouchZoom, { passive: false })
  stop = installIOSTouchScrollGuard()
})
afterEach(() => {
  stop()
  document.removeEventListener('touchmove', preventPageTouchZoom)
  document.body.replaceChildren()
})
afterAll(() => { Object.assign(globalThis, originals); dom.window.close() })

type Point = { identifier: number; clientX: number; clientY: number; touchType?: 'stylus' | 'direct' }
const finger = (x = 50, y = 50, identifier = 1): Point => ({ identifier, clientX: x, clientY: y })
const pencil = (x = 50, y = 50): Point => ({ ...finger(x, y, 2), touchType: 'stylus' })
function touch(type: string, points: Point[], changed = points): TouchEvent {
  const event = new dom.window.Event(type, { bubbles: true, composed: true, cancelable: true }) as unknown as TouchEvent
  Object.defineProperties(event, { touches: { value: points }, changedTouches: { value: changed } })
  target.dispatchEvent(event)
  return event
}
function swipe(from: Point, to: Point): TouchEvent {
  touch('touchstart', [from])
  return touch('touchmove', [to])
}
function scrollContainer(horizontal = false): HTMLElement {
  const el = document.createElement('div')
  el.style[horizontal ? 'overflowX' : 'overflowY'] = 'auto'
  Object.defineProperties(el, {
    clientHeight: { value: 100 }, scrollHeight: { value: horizontal ? 100 : 500, configurable: true },
    clientWidth: { value: 100 }, scrollWidth: { value: horizontal ? 500 : 100 },
  })
  document.body.append(el)
  el.append(target)
  return el
}

describe('installed-iOS touch guard', () => {
  test('preserves tap jitter on both axes, including unknown touch types', () => {
    for (const [x, y] of [[50, 51], [53, 54], [50, 60], [56, 58]]) {
      expect(swipe(finger(), finger(x, y)).defaultPrevented).toBe(false)
    }
  })

  test('blocks actual finger swipes on the page, including after returning near the start', () => {
    expect(swipe(finger(), finger(50, 61)).defaultPrevented).toBe(true)
    expect(touch('touchmove', [finger(50, 55)]).defaultPrevented).toBe(true)
    expect(swipe(finger(), finger(50, 30)).defaultPrevented).toBe(true)
  })

  test('leaves Pencil taps, vertical strokes and horizontal strokes to native controls', () => {
    for (const tag of ['button', 'input', 'select', 'textarea', 'canvas']) {
      const control = document.createElement(tag)
      target.replaceWith(control)
      target = control
      expect(touch('touchstart', [pencil()]).defaultPrevented).toBe(false)
      for (const point of [pencil(50, 51), pencil(50, 150), pencil(150, 50)]) {
        expect(touch('touchmove', [point]).defaultPrevented).toBe(false)
      }
      expect(touch('touchend', [], [pencil(150, 50)]).defaultPrevented).toBe(false)
    }
  })

  test('does not treat Pencil movement with a resting palm as a page pinch', () => {
    const palm = finger(100, 100)
    touch('touchstart', [palm], [palm])
    touch('touchstart', [palm, pencil()], [pencil()])
    expect(touch('touchmove', [palm, pencil(50, 150)], [pencil(50, 150)]).defaultPrevented).toBe(false)
    // A second resting finger must not turn a Pencil-only move into a pinch.
    const other = finger(150, 100, 3)
    expect(touch('touchmove', [palm, other, pencil(50, 160)], [pencil(50, 160)]).defaultPrevented).toBe(false)
  })

  test('still suppresses two-finger page zoom, with or without a Pencil present', () => {
    const a = finger(), b = finger(100, 100, 3)
    expect(touch('touchmove', [a, b]).defaultPrevented).toBe(true)
    expect(touch('touchmove', [a, b, pencil()], [a]).defaultPrevented).toBe(true)
    expect(touch('touchmove', [a, pencil()], [a]).defaultPrevented).toBe(false)
  })

  test('does not infer a stylus from pressure or an unrecognized type', () => {
    const pressured = { ...finger(), force: 1 }
    expect(swipe(pressured, { ...pressured, clientY: 80 }).defaultPrevented).toBe(true)
    expect(isStylusTouchEvent(touch('touchmove', [finger()]))).toBe(false)
    expect(isStylusTouchEvent(touch('touchend', [], []))).toBe(false)
    expect(isStylusTouchEvent(touch('touchmove', [pencil(), finger()]))).toBe(false)
    expect(isStylusTouchEvent(touch('touchmove', [pencil()], []))).toBe(true)
  })

  test('allows inner scrolling but guards outward swipes at both boundaries', () => {
    const el = scrollContainer()
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(true) // top -> outward
    expect(swipe(finger(), finger(50, 20)).defaultPrevented).toBe(false) // top -> inward
    el.scrollTop = 200
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(false)
    expect(swipe(finger(), finger(50, 20)).defaultPrevented).toBe(false)
    el.scrollTop = 400
    expect(swipe(finger(), finger(50, 20)).defaultPrevented).toBe(true) // bottom -> outward
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(false) // bottom -> inward
    expect(swipe(finger(), finger(50, 48)).defaultPrevented).toBe(false) // bottom tap jitter
    expect(swipe(pencil(), pencil(50, 20)).defaultPrevented).toBe(false)
  })

  test('keeps horizontal sliders, carousels and horizontal-only containers native', () => {
    expect(swipe(finger(), finger(80, 52)).defaultPrevented).toBe(false)
    scrollContainer(true)
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(false)
  })

  test('does not mistake overflow without overflowing content for a scroll container', () => {
    const el = scrollContainer()
    Object.defineProperty(el, 'scrollHeight', { value: 100 })
    expect(swipe(finger(), finger(50, 20)).defaultPrevented).toBe(true)
  })

  test('allows native panning while the visual viewport is magnified', () => {
    viewport.scale = 1.5
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(false)
  })

  test('does not reuse a finished or canceled gesture or a different finger', () => {
    for (const type of ['touchend', 'touchcancel']) {
      expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(true)
      touch(type, [], [finger(50, 80)])
      expect(touch('touchmove', [finger(50, 90)]).defaultPrevented).toBe(false)
    }
    touch('touchstart', [finger()])
    expect(touch('touchmove', [finger(50, 80, 3)]).defaultPrevented).toBe(false)
  })

  test('does not reinterpret the remainder of a pinch as a single-finger swipe', () => {
    touch('touchstart', [finger()])
    const other = finger(100, 100, 3)
    touch('touchstart', [finger(), other], [other])
    touch('touchend', [finger()], [other])
    expect(touch('touchmove', [finger(50, 80)]).defaultPrevented).toBe(false)
  })

  test('uninstall removes touch listeners and discards the current gesture', () => {
    touch('touchstart', [finger()])
    stop()
    expect(touch('touchmove', [finger(50, 80)]).defaultPrevented).toBe(false)
    stop = installIOSTouchScrollGuard()
    expect(touch('touchmove', [finger(50, 80)]).defaultPrevented).toBe(false)
    expect(swipe(finger(), finger(50, 80)).defaultPrevented).toBe(true)
  })
})
