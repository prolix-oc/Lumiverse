import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  MouseEvent: dom.window.MouseEvent,
  WheelEvent: dom.window.WheelEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('motion/react', () => ({
  motion: {
    div: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
      initial?: unknown
      animate?: unknown
      exit?: unknown
      transition?: unknown
    }>(function MotionDiv({ initial, animate, exit, transition, ...props }, ref) {
      return createElement('div', { ...props, ref })
    }),
  },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
mock.module('./ContextMenu', () => ({ default: () => null }))
mock.module('./ConfirmationModal', () => ({ default: () => null }))
mock.module('@/lib/toast', () => ({ toast: { success: () => {}, error: () => {} } }))

const { createRoot } = await import('react-dom/client')
const { default: ImageLightbox } = await import('./ImageLightbox')

let root: Root
let host: HTMLDivElement
let image: HTMLImageElement
let backdrop: HTMLDivElement
let capturedPointers: Set<number>

function touch(type: string, positions: Array<[number, number]>, target: Element = image) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: positions.map(([clientX, clientY]) => ({ clientX, clientY })),
  })
  act(() => target.dispatchEvent(event))
}

function wheel(deltaY: number, target: Element = image, options: WheelEventInit = {}) {
  const event = new dom.window.WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaY, clientX: 200, clientY: 400, ...options,
  })
  act(() => target.dispatchEvent(event))
  return event
}

function pointer(type: string, clientX: number, clientY: number, options: PointerEventInit = {}) {
  const event = new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 1,
    button: 0, buttons: type === 'pointermove' || type === 'pointerdown' ? 1 : 0,
    clientX, clientY, ...options,
  })
  act(() => image.dispatchEvent(event))
}

function gesture(type: string, scale: number, target: Element = image) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'scale', { value: scale })
  act(() => target.dispatchEvent(event))
  return event
}

function zoomState() {
  const match = image.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) scale\(([\d.]+)\)/)!
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) }
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ImageLightbox, {
    src: 'https://lumiverse.test/first.png',
    onClose: () => {},
  })))
  image = document.querySelector('img')!
  backdrop = image.parentElement as HTMLDivElement
  Object.defineProperties(image, {
    offsetWidth: { configurable: true, value: 360 },
    offsetHeight: { configurable: true, value: 600 },
  })
  image.getBoundingClientRect = () => ({ left: 20, top: 100, width: 360, height: 600 }) as DOMRect
  capturedPointers = new Set()
  image.setPointerCapture = (pointerId) => { capturedPointers.add(pointerId) }
  image.hasPointerCapture = (pointerId) => capturedPointers.has(pointerId)
  image.releasePointerCapture = (pointerId) => { capturedPointers.delete(pointerId) }
  Object.defineProperties(backdrop, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 800 },
  })
  backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.style.removeProperty('--lumiverse-ui-scale')
})

afterAll(() => {
  mock.restore()
  Object.assign(globals, originals)
  dom.window.close()
})

describe('ImageLightbox image-only zoom', () => {
  test('zooms the image, pans it after lifting one finger, and resets for another image', async () => {
    touch('touchstart', [[150, 400]])
    touch('touchstart', [[150, 400], [250, 400]])
    touch('touchmove', [[100, 400], [300, 400]])
    expect(image.style.transform).toContain('scale(2)')

    touch('touchend', [[300, 400]])
    touch('touchmove', [[350, 400]])
    expect(image.style.transform).toContain('translate3d(50px, 0px, 0)')
    touch('touchend', [])

    await act(async () => root.render(createElement(ImageLightbox, {
      src: 'https://lumiverse.test/second.png',
      onClose: () => {},
    })))
    expect(image.style.transform).toContain('scale(1)')
  })

  test('does not zoom the image when touches begin on the backdrop', () => {
    touch('touchstart', [[150, 400]], backdrop)
    touch('touchstart', [[150, 400], [250, 400]], backdrop)
    touch('touchmove', [[100, 400], [300, 400]], backdrop)
    expect(image.style.transform).toContain('scale(1)')
  })

  test('converts touch movement to layout pixels when the UI is scaled', () => {
    document.documentElement.style.setProperty('--lumiverse-ui-scale', '1.5')
    backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 1200 }) as DOMRect

    touch('touchstart', [[225, 600]])
    touch('touchstart', [[225, 600], [375, 600]])
    touch('touchmove', [[150, 600], [450, 600]])
    touch('touchend', [[450, 600]])
    touch('touchmove', [[525, 600]])

    expect(image.style.transform).toContain('translate3d(50px, 0px, 0)')
    expect(image.style.transform).toContain('scale(2)')
  })

  test('zooms toward the cursor on the image with wheel and ctrl-wheel, but not on the backdrop', () => {
    expect(wheel(-120, backdrop).defaultPrevented).toBe(false)
    expect(zoomState().scale).toBe(1)

    expect(wheel(-120, image, { clientX: 300 }).defaultPrevented).toBe(true)
    const zoomed = zoomState()
    expect(zoomed.scale).toBeGreaterThan(1)
    expect(zoomed.x).toBeCloseTo((1 - zoomed.scale) * 100)
    expect(zoomed.y).toBe(0)

    wheel(-5000, image, { ctrlKey: true })
    expect(zoomState().scale).toBe(4)
    wheel(5000, image, { ctrlKey: true })
    expect(zoomState()).toEqual({ x: 0, y: 0, scale: 1 })
  })

  test('drags a zoomed image with the left mouse button and releases pointer capture', () => {
    pointer('pointerdown', 200, 400)
    expect(capturedPointers.size).toBe(0)
    wheel(-Math.log(2) / 0.002)
    expect(zoomState().scale).toBeCloseTo(2)

    pointer('pointerdown', 200, 400, { pointerType: 'touch' })
    pointer('pointerdown', 200, 400, { button: 2 })
    expect(capturedPointers.size).toBe(0)

    pointer('pointerdown', 200, 400, { pointerId: 7 })
    expect(capturedPointers.has(7)).toBe(true)
    expect(image.style.cursor).toBe('grabbing')
    pointer('pointermove', 250, 400, { pointerId: 8 })
    expect(zoomState().x).toBe(0)
    pointer('pointermove', 250, 400, { pointerId: 7 })
    expect(zoomState().x).toBe(50)
    pointer('pointermove', 1000, 400, { pointerId: 7 })
    expect(zoomState().x).toBe(160)

    pointer('pointerup', 1000, 400, { pointerId: 7 })
    expect(capturedPointers.size).toBe(0)
    expect(image.style.cursor).toBe('grab')
    pointer('pointermove', 900, 400, { pointerId: 7 })
    expect(zoomState().x).toBe(160)

    pointer('pointerdown', 200, 400, { pointerId: 9 })
    pointer('pointercancel', 200, 400, { pointerId: 9 })
    expect(capturedPointers.size).toBe(0)
  })

  test('accounts for UI scale for wheel zoom and mouse panning', () => {
    document.documentElement.style.setProperty('--lumiverse-ui-scale', '1.5')
    backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 1200 }) as DOMRect

    wheel(-Math.log(2) / 0.002, image, { clientX: 450, clientY: 600 })
    expect(zoomState().scale).toBeCloseTo(2)
    expect(zoomState().x).toBeCloseTo(-100)

    pointer('pointerdown', 450, 600)
    pointer('pointermove', 600, 600)
    expect(zoomState().x).toBeCloseTo(0)
    pointer('pointerup', 600, 600)
  })

  test('releases an active mouse pan when switching images', async () => {
    wheel(-Math.log(2) / 0.002)
    pointer('pointerdown', 200, 400, { pointerId: 7 })
    expect(capturedPointers.has(7)).toBe(true)

    await act(async () => root.render(createElement(ImageLightbox, {
      src: 'https://lumiverse.test/second.png',
      onClose: () => {},
    })))
    expect(capturedPointers.size).toBe(0)
    expect(zoomState().scale).toBe(1)
    expect(image.style.cursor).toBe('')
  })

  test('handles Safari gesture scale from its start and ignores gestures outside the image', () => {
    gesture('gesturechange', 2)
    gesture('gesturestart', 1, backdrop)
    gesture('gesturechange', 2)
    expect(zoomState().scale).toBe(1)

    pointer('pointermove', 300, 400, { buttons: 0 })
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true)
    expect(wheel(-120, image, { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(zoomState().scale).toBe(1)
    expect(gesture('gesturechange', 2).defaultPrevented).toBe(true)
    expect(zoomState()).toEqual({ x: -100, y: 0, scale: 2 })
    gesture('gesturechange', 1.5)
    expect(zoomState()).toEqual({ x: -50, y: 0, scale: 1.5 })
    gesture('gestureend', 1.5)
    gesture('gesturechange', 3)
    expect(zoomState().scale).toBe(1.5)
  })

  test('does not apply Safari gesture events on top of a touch pinch', () => {
    touch('touchstart', [[150, 400], [250, 400]])
    gesture('gesturestart', 1)
    touch('touchmove', [[100, 400], [300, 400]])
    gesture('gesturechange', 2)
    expect(zoomState().scale).toBe(2)
    touch('touchend', [])
    gesture('gesturechange', 3)
    expect(zoomState().scale).toBe(2)
  })
})
