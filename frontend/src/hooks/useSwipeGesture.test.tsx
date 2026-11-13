import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import useSwipeGesture from './useSwipeGesture'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

const viewport = { scale: 1 }
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
const { createRoot } = await import('react-dom/client')

let root: Root
let container: HTMLDivElement
let card: HTMLDivElement
let swipes: string[]

function Probe() {
  const ref = useRef<HTMLDivElement>(null)
  useSwipeGesture(ref, {
    enabled: true,
    onSwipeLeft: () => swipes.push('left'),
    onSwipeRight: () => swipes.push('right'),
  })
  return <div ref={ref} />
}

function dispatchTouches(type: string, positions: Array<[number, number]>): boolean {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: positions.map(([clientX, clientY]) => ({ clientX, clientY })),
  })
  card.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  viewport.scale = 1
  swipes = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
  card = container.querySelector('div')!
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

afterAll(() => {
  Object.assign(globals, originals)
  dom.window.close()
})

describe('useSwipeGesture', () => {
  test('still recognizes a single-finger horizontal swipe', () => {
    dispatchTouches('touchstart', [[20, 20]])
    expect(dispatchTouches('touchmove', [[90, 21]])).toBe(true)
    dispatchTouches('touchend', [])
    expect(swipes).toEqual(['left'])
  })

  test('keeps a multi-touch sequence cancelled until every finger lifts', () => {
    dispatchTouches('touchstart', [[100, 100]])
    dispatchTouches('touchstart', [[100, 100], [120, 100]])
    dispatchTouches('touchmove', [[95, 100], [145, 100]])
    dispatchTouches('touchend', [[145, 100]])
    expect(dispatchTouches('touchmove', [[235, 100]])).toBe(false)
    dispatchTouches('touchend', [])
    expect(swipes).toEqual([])

    dispatchTouches('touchstart', [[50, 100]])
    dispatchTouches('touchmove', [[130, 100]])
    dispatchTouches('touchend', [])
    expect(swipes).toEqual(['left'])
  })

  test('does not claim a pan while zoomed or a cancelled touch', () => {
    viewport.scale = 2
    dispatchTouches('touchstart', [[100, 100]])
    expect(dispatchTouches('touchmove', [[220, 100]])).toBe(false)
    dispatchTouches('touchend', [])
    viewport.scale = 1

    dispatchTouches('touchstart', [[100, 100]])
    dispatchTouches('touchcancel', [])
    expect(dispatchTouches('touchmove', [[220, 100]])).toBe(false)
    dispatchTouches('touchend', [])
    expect(swipes).toEqual([])
  })
})
