import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { useDrawerResize } from './useDrawerResize'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(dom.window, 'innerWidth', { value: 1440 })
dom.window.HTMLElement.prototype.setPointerCapture = () => undefined
dom.window.HTMLElement.prototype.hasPointerCapture = () => false

function probe(side: 'left' | 'right' = 'right') {
  const commits: number[] = []
  function Probe() {
    const ref = useRef<HTMLDivElement>(null)
    const resize = useDrawerResize(ref, side, (width) => commits.push(width))
    return <div ref={ref} data-width={resize.draftWidth ?? ''}><div data-handle {...resize.handlers} /></div>
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<Probe />))
  const drawer = host.firstElementChild as HTMLDivElement
  drawer.getBoundingClientRect = () => ({ width: 420 } as DOMRect)
  const handle = drawer.firstElementChild!
  const pointer = (type: string, x: number) => act(() => { handle.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: x })) })
  return { drawer, handle, pointer, commits, close: () => { act(() => root.unmount()); host.remove() } }
}

describe('sidebar resize interaction', () => {
  test('previews drag immediately and commits once on release', () => {
    const p = probe()
    try {
      p.pointer('pointerdown', 1000)
      p.pointer('pointermove', 850)
      expect(p.drawer.dataset.width).toBe('570')
      expect(p.commits).toEqual([])
      p.pointer('pointerup', 850)
      expect(p.commits).toEqual([570])
      expect(p.drawer.dataset.width).toBe('')
    } finally { p.close() }
  })
  test('cancellation restores saved geometry without persisting a partial drag', () => {
    const p = probe('left')
    try {
      p.pointer('pointerdown', 420)
      p.pointer('pointermove', 600)
      expect(p.drawer.dataset.width).toBe('600')
      p.pointer('pointercancel', 600)
      expect(p.commits).toEqual([])
      expect(p.drawer.dataset.width).toBe('')
    } finally { p.close() }
  })
  test('keyboard grows the inner edge and Home resets width', () => {
    const p = probe()
    try {
      act(() => { p.handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })) })
      act(() => { p.handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' })) })
      expect(p.commits).toEqual([440, 420])
    } finally { p.close() }
  })
})
