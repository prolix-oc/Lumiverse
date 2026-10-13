import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { observeComposerMotion } from './composerMotion'

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
