import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useLandingVirtualizer } from './useLandingVirtualizer'

test('an Android fling commits its new virtual range before the next paint', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'getComputedStyle', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]))
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, ResizeObserver: ResizeObserverStub, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(dom.window, 'ResizeObserver', { value: ResizeObserverStub })
  dom.window.document.documentElement.dataset.tauriMobile = 'android'
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetWidth: { get: () => 393 }, offsetHeight: { get: () => 600 },
    clientWidth: { get: () => 393 }, clientHeight: { get: () => 600 },
    scrollHeight: { get: () => 100000 },
    scrollTo: { value: function(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0 } },
  })
  const rowKeys = Array.from({ length: 1000 }, (_, i) => `row-${i}`)
  function Fixture() {
    const scrollRef = useRef<HTMLDivElement>(null)
    const { virtualizer } = useLandingVirtualizer({
      geometry: { layout: 'cards', width: 393, columns: 1, gap: 0, rowEstimate: 100, uiScale: 1, fontScale: 1, viewportWidth: 393 },
      rowKeys, scrollRef, scrollMargin: 0, snapshotRef: null,
    })
    return <div id="scroll" ref={scrollRef}>{virtualizer.getVirtualItems().map(row => <div key={row.key} data-index={row.index} />)}</div>
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Fixture />))
    const scroll = host.querySelector<HTMLElement>('#scroll')!
    act(() => {
      scroll.scrollTop = 20000
      scroll.dispatchEvent(new dom.window.Event('scroll'))
      const mounted = [...host.querySelectorAll<HTMLElement>('[data-index]')].map(row => Number(row.dataset.index))
      expect(mounted).toContain(200)
      expect(mounted).toContain(205)
      expect(mounted.length).toBeLessThan(30)
      expect(mounted).not.toContain(0)
    })
  } finally {
    act(() => root.unmount())
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
  }
})
