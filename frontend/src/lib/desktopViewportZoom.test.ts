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
  overflowX = ''
  overflowY = ''
  overscrollBehaviorX = ''
  overscrollBehaviorY = ''
  direction = 'ltr'
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
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  scrollLeft = 0
  scrollWidth = 0
  clientWidth = 0
  get parentElement() { return this.parent }
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
  getComputedStyle: (el?: FakeElement) => el?.style ?? fakeDocument.documentElement.style,
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

  test('allows chat scrolling while zoomed and chains unconsumed scroll to pan', () => {
    const chatList = new FakeElement()
    chatList.style.overflowY = 'auto'
    chatList.style.overflowX = 'hidden'
    chatList.style.overscrollBehaviorY = 'contain'
    chatList.clientHeight = 600
    chatList.scrollHeight = 1200
    chatList.scrollTop = 200
    const message = new FakeElement()
    message.parent = chatList

    wheel(-Math.log(2) / 0.01, { ctrlKey: true }, message)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')

    // Scrolling within the chat list leaves native scroll intact and does not pan.
    expect(wheel(50, {}, message).defaultPrevented).toBe(false)
    expect(wheel(-50, {}, message).defaultPrevented).toBe(false)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')

    // Small incidental horizontal trackpad drift during vertical scroll does not pan sideways.
    expect(wheel(50, { deltaX: 3 }, message).defaultPrevented).toBe(false)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')

    // Intentional diagonal scroll pans horizontally while vertical chat scroll stays native.
    expect(wheel(50, { deltaX: 30 }, message).defaultPrevented).toBe(false)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-230px, -300px, 0) scale(2)')

    // Pure horizontal swipe over vertical-only chat pans horizontally.
    expect(wheel(0, { deltaX: -20 }, message).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-210px, -300px, 0) scale(2)')

    // Hitting top or bottom chat boundaries chains into viewport panning.
    chatList.scrollTop = 0
    expect(wheel(-40, {}, message).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-210px, -260px, 0) scale(2)')

    // Treat fractional UI-scale bottom readings within 1px as at the bottom.
    chatList.scrollTop = 599.4
    expect(wheel(40, {}, message).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-210px, -300px, 0) scale(2)')
  })

  test('respects nested scroll containers, overscroll-behavior, composedPath, and pre-consumed events', () => {
    const chatList = new FakeElement()
    chatList.style.overflowY = 'auto'
    chatList.style.overscrollBehaviorY = 'contain'
    chatList.clientHeight = 600
    chatList.scrollHeight = 1200
    chatList.scrollTop = 200

    const innerBox = new FakeElement()
    innerBox.parent = chatList
    innerBox.style.overflowY = 'auto'
    innerBox.style.overflowX = 'auto'
    innerBox.clientHeight = 100
    innerBox.scrollHeight = 100
    innerBox.clientWidth = 200
    innerBox.scrollWidth = 400
    innerBox.scrollLeft = 50

    const islandChild = new FakeElement()
    islandChild.parent = innerBox

    // ctrl+wheel still zooms even if an earlier global listener (e.g. main.tsx) marked defaultPrevented.
    const zoomEvent = new FakeWheelEvent({ deltaY: -Math.log(2) / 0.01, ctrlKey: true })
    Object.defineProperty(zoomEvent, 'target', { value: islandChild })
    zoomEvent.preventDefault()
    fakeDocument.dispatchEvent(zoomEvent)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -300px, 0) scale(2)')

    // Inner box has no vertical overflow (even with overscroll-behavior: contain), so vertical scroll reaches chatList.
    innerBox.style.overscrollBehaviorY = 'contain'
    expect(wheel(30, {}, islandChild).defaultPrevented).toBe(false)

    // When inner box does overflow vertically at its boundary with overscroll-behavior: contain, it does not chain to chatList.
    innerBox.scrollHeight = 300
    innerBox.scrollTop = 0
    expect(wheel(-30, {}, islandChild).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-200px, -270px, 0) scale(2)')

    // Horizontal wheel inside overflowing innerBox scrolls natively; at edge without contain, pans viewport.
    expect(wheel(0, { deltaX: 25 }, islandChild).defaultPrevented).toBe(false)
    innerBox.scrollLeft = 200
    expect(wheel(0, { deltaX: 25 }, islandChild).defaultPrevented).toBe(true)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-225px, -270px, 0) scale(2)')

    // Already-prevented non-ctrl wheel event (e.g. horizontal bar hook) is ignored.
    const consumedWheel = new FakeWheelEvent({ deltaY: 40 })
    Object.defineProperty(consumedWheel, 'target', { value: app })
    consumedWheel.preventDefault()
    fakeDocument.dispatchEvent(consumedWheel)
    expect(fakeDocument.body.style.transform).toContain('translate3d(-225px, -270px, 0) scale(2)')

    // composedPath() finds scrollable ancestors across shadow DOM boundaries even when target is retargeted.
    const shadowInner = new FakeElement()
    const retargetedEvent = new FakeWheelEvent({ deltaY: 40 })
    Object.defineProperty(retargetedEvent, 'target', { value: app })
    Object.defineProperty(retargetedEvent, 'composedPath', { value: () => [shadowInner, chatList, fakeDocument.body] })
    fakeDocument.dispatchEvent(retargetedEvent)
    expect(retargetedEvent.defaultPrevented).toBe(false)

    // Ignore 1px subpixel rounding overflow and overflow: hidden containers.
    const subpixelBox = new FakeElement()
    subpixelBox.style.overflowY = 'auto'
    subpixelBox.clientHeight = 500
    subpixelBox.scrollHeight = 501
    expect(wheel(20, {}, subpixelBox).defaultPrevented).toBe(true)

    const hiddenBox = new FakeElement()
    hiddenBox.style.overflowY = 'hidden'
    hiddenBox.clientHeight = 500
    hiddenBox.scrollHeight = 1000
    hiddenBox.scrollTop = 100
    expect(wheel(20, {}, hiddenBox).defaultPrevented).toBe(true)
  })
})
