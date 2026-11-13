import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  constrainViewportZoom,
  installDesktopViewportZoom,
  panViewport,
  zoomViewportFrom,
} from './desktopViewportZoom'

const viewport = { width: 1000, height: 800 }

describe('desktop viewport zoom geometry', () => {
  test('keeps the pinch point anchored and supports midpoint movement', () => {
    expect(zoomViewportFrom({ scale: 1, x: 0, y: 0 }, 2,
      { x: 200, y: 300 }, { x: 200, y: 300 }, viewport))
      .toEqual({ scale: 2, x: -200, y: -300 })
    expect(zoomViewportFrom({ scale: 1, x: 0, y: 0 }, 2,
      { x: 200, y: 300 }, { x: 230, y: 260 }, viewport))
      .toEqual({ scale: 2, x: -170, y: -340 })
  })

  test('clamps scale and panning to the magnified content', () => {
    expect(constrainViewportZoom({ scale: 4, x: -5000, y: 200 }, viewport))
      .toEqual({ scale: 3, x: -2000, y: 0 })
    expect(panViewport({ scale: 2, x: -200, y: -300 }, { x: -900, y: 500 }, viewport))
      .toEqual({ scale: 2, x: -1000, y: 0 })
    expect(constrainViewportZoom({ scale: 1, x: -100, y: -100 }, viewport))
      .toEqual({ scale: 1, x: 0, y: 0 })
  })
})

class FakeStyle {
  transform = ''
  transformOrigin = ''
  private properties = new Map<string, string>()
  setProperty(key: string, value: string) { this.properties.set(key, value) }
  getPropertyValue(key: string) { return this.properties.get(key) ?? '' }
  removeProperty(key: string) {
    if (key === 'transform') this.transform = ''
    if (key === 'transform-origin') this.transformOrigin = ''
    this.properties.delete(key)
  }
}

class FakeElement extends EventTarget {
  style = new FakeStyle()
  parent: FakeElement | null = null
  exempt = false
  attributes = new Set<string>()
  hasAttribute(key: string) { return this.attributes.has(key) }
  closest(selector: string): FakeElement | null {
    if (selector === '[data-viewport-zoom-exempt]' && this.exempt) return this
    return this.parent?.closest(selector) ?? null
  }
}

class FakeDocument extends EventTarget {
  documentElement = new FakeElement()
  body = new FakeElement()
}

class FakeWheelEvent extends Event {
  static DOM_DELTA_LINE = 1
  static DOM_DELTA_PAGE = 2
  deltaMode = 0
  deltaX = 0
  deltaY = 0
  clientX = 200
  clientY = 300
  ctrlKey = false
  constructor(options: Record<string, number | boolean>) {
    super('wheel', { cancelable: true })
    Object.assign(this, options)
  }
}

const fakeDocument = new FakeDocument()
const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 })
const app = new FakeElement()
const lightbox = new FakeElement()
const image = new FakeElement()
lightbox.exempt = true
image.parent = lightbox
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: fakeWindow,
  document: fakeDocument,
  navigator: { userAgent: 'Desktop Browser', platform: 'Win32', maxTouchPoints: 10 },
  Element: FakeElement,
  WheelEvent: FakeWheelEvent,
  MutationObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => fakeDocument.documentElement.style,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

let uninstall: () => void

function wheel(deltaY: number, options: Record<string, number | boolean> = {}, target: FakeElement = app) {
  const event = new FakeWheelEvent({ deltaY, ...options })
  Object.defineProperty(event, 'target', { value: target })
  fakeDocument.dispatchEvent(event)
  return event
}

function touch(type: string, positions: Array<[number, number]>) {
  const event = new Event(type, { cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: positions.map(([clientX, clientY]) => ({ clientX, clientY })),
  })
  Object.defineProperty(event, 'target', { value: app })
  fakeDocument.dispatchEvent(event)
  return event
}

function gesture(type: string, scale: number, target: FakeElement = app) {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { scale, clientX: 200, clientY: 300 })
  Object.defineProperty(event, 'target', { value: target })
  fakeDocument.dispatchEvent(event)
  return event
}

beforeEach(() => {
  fakeDocument.documentElement.style.setProperty('--lumiverse-ui-scale', '1')
  uninstall = installDesktopViewportZoom()
})

afterEach(() => {
  uninstall()
  fakeDocument.documentElement.style.removeProperty('--lumiverse-ui-scale')
})

afterAll(() => {
  Object.assign(globals, originals)
})

describe('desktop viewport zoom input', () => {
  test('pinches at the pointer, pans with wheel, and resets with Ctrl+0', () => {
    expect(wheel(-Math.log(2) / 0.01, { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')
    expect(wheel(50).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -350px, 0) scale(2)')
    const reset = new Event('keydown', { cancelable: true })
    Object.assign(reset, { key: '0', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
    fakeDocument.dispatchEvent(reset)
    expect(fakeDocument.body.style.transform).toBe('')
    expect(wheel(50).defaultPrevented).toBe(false)
  })

  test('compensates existing UI Scale and leaves image lightbox gestures alone', () => {
    fakeDocument.documentElement.style.setProperty('--lumiverse-ui-scale', '1.5')
    expect(wheel(-Math.log(2) / 0.01, { ctrlKey: true }, image).defaultPrevented).toBe(false)
    expect(fakeDocument.body.style.transform).toBe('')
    wheel(-Math.log(2) / 0.01, { ctrlKey: true })
    expect(fakeDocument.body.style.transform).toContain('translate3d(-133.33333333333334px, -200px, 0) scale(2)')
  })

  test('touchscreen pinch uses its midpoint and a two-finger drag pans', () => {
    touch('touchstart', [[100, 300], [300, 300]])
    expect(touch('touchmove', [[0, 300], [400, 300]]).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')
    touch('touchmove', [[0, 250], [400, 250]])
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -350px, 0) scale(2)')
  })

  test('Safari gesture scale applies once and resets when pinched back', () => {
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true)
    expect(gesture('gesturechange', 2).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')
    wheel(-20, { ctrlKey: true })
    expect(fakeDocument.body.style.transform).toContain('scale(2)')
    gesture('gesturechange', 1)
    expect(fakeDocument.body.style.transform).toBe('')
    gesture('gestureend', 1)
  })

  test('does not install on mobile devices or floating widget windows', () => {
    uninstall()
    ;(navigator as Navigator & { userAgent: string }).userAgent = 'Android'
    uninstall = installDesktopViewportZoom()
    expect(wheel(-100, { ctrlKey: true }).defaultPrevented).toBe(false)
    ;(navigator as Navigator & { userAgent: string }).userAgent = 'Desktop Browser'
    fakeDocument.documentElement.attributes.add('data-tauri-floating-widget')
    uninstall = installDesktopViewportZoom()
    expect(wheel(-100, { ctrlKey: true }).defaultPrevented).toBe(false)
    fakeDocument.documentElement.attributes.clear()
  })
})
