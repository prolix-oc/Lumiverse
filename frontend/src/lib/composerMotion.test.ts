import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { measureComposerHeight, observeComposerMotion } from './composerMotion'

const dom = new JSDOM('<div id="composer"><span></span></div>')
const element = dom.window.document.querySelector<HTMLElement>('#composer')!
let nextFrame = 0
const frames = new Map<number, FrameRequestCallback>()
dom.window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
dom.window.cancelAnimationFrame = id => { frames.delete(id) }
let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined; frames.clear() })
afterAll(() => dom.window.close())

function transition(type: string, propertyName: string, target: Element = element) {
  const event = new dom.window.Event(type, { bubbles: true })
  Object.assign(event, { propertyName })
  target.dispatchEvent(event)
}
function paint() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(0))
}

describe('composer overlay clearance', () => {
  test('reserves the same space through opening, closing and a reversed transition', () => {
    const composer = dom.window.document.createElement('div')
    const popover = dom.window.document.createElement('div')
    const content = dom.window.document.createElement('div')
    composer.append(popover)
    popover.append(content)
    Object.defineProperty(content, 'scrollHeight', { value: 240 })
    let visiblePanelHeight = 0
    composer.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 300, 100 + visiblePanelHeight)
    popover.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 300, visiblePanelHeight)

    for (const height of [0, 0.49, 0.51, 30.4, 120.6, 240, 180.5, 100, 130.8, 50.2, 0]) {
      visiblePanelHeight = height
      expect(Math.round(measureComposerHeight(composer, popover))).toBe(100)
    }
    // Closing content is retained for 250ms, then removed. Neither step
    // should move the messages, including when the chat is still tail-pinned.
    popover.replaceChildren()
    expect(measureComposerHeight(composer, popover)).toBe(100)
  })

  test('retains real composer growth and keyboard clearance at non-default UI zoom', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle
    globalThis.getComputedStyle = (() => ({ getPropertyValue: () => '1.25' })) as any
    try {
      const composer = dom.window.document.createElement('div')
      const popover = dom.window.document.createElement('div')
      let baseHeight = 100
      let visiblePanelHeight = 180.4
      composer.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 300, (baseHeight + visiblePanelHeight) * 1.25)
      popover.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 300, visiblePanelHeight * 1.25)
      expect(measureComposerHeight(composer, popover)).toBeCloseTo(100)
      baseHeight = 160 // A taller draft, attachment, extension or safe-area padding.
      expect(measureComposerHeight(composer, popover)).toBeCloseTo(160)
      visiblePanelHeight = 0
      expect(measureComposerHeight(composer, popover)).toBeCloseTo(160)
      Object.defineProperty(composer, 'offsetHeight', { value: 160 })
      expect(measureComposerHeight(composer, null)).toBe(160)
    } finally {
      globalThis.getComputedStyle = originalGetComputedStyle
    }
  })
})

describe('composer motion measurements', () => {
  test('measures every frame and the final position on every keyboard cycle', () => {
    let measurements = 0
    stop = observeComposerMotion(element, () => measurements++)
    for (let cycle = 0; cycle < 3; cycle++) {
      transition('transitionrun', 'bottom')
      paint(); paint()
      expect(frames.size).toBe(1)
      transition('transitionend', 'bottom')
      expect(frames.size).toBe(0)
    }
    expect(measurements).toBe(9)
  })

  test('tracks overlapping bottom and safe-area padding transitions', () => {
    stop = observeComposerMotion(element, () => {})
    transition('transitionrun', 'bottom')
    transition('transitionrun', 'padding-bottom')
    expect(frames.size).toBe(1)
    transition('transitionend', 'bottom')
    paint()
    expect(frames.size).toBe(1)
    transition('transitionend', 'padding-bottom')
    expect(frames.size).toBe(0)
  })

  test('resumes when keyboard motion is interrupted and retargeted', () => {
    let measurements = 0
    stop = observeComposerMotion(element, () => measurements++)
    transition('transitionrun', 'bottom')
    paint()
    transition('transitioncancel', 'bottom')
    transition('transitionrun', 'bottom')
    paint()
    transition('transitionend', 'bottom')
    expect(measurements).toBe(4)
    expect(frames.size).toBe(0)
  })

  test('ignores unrelated or descendant transitions and stops on unmount', () => {
    let measurements = 0
    stop = observeComposerMotion(element, () => measurements++)
    transition('transitionrun', 'opacity')
    transition('transitionrun', 'bottom', element.firstElementChild!)
    expect(frames.size).toBe(0)
    transition('transitionrun', 'bottom')
    stop()
    transition('transitionrun', 'bottom')
    paint()
    expect(measurements).toBe(0)
    expect(frames.size).toBe(0)
  })
})
