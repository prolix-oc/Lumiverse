import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { ResizablePanelFrame } from './ResizablePanelFrame'

describe('ResizablePanelFrame geometry persistence', () => {
  test('commits a drag and writes the requested geometry key', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://lumiverse.test/' })
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      navigator: dom.window.navigator,
      PointerEvent: dom.window.MouseEvent,
    })
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

    const commits: Array<{ x: number; y: number }> = []
    const root = document.getElementById('root')!
    const reactRoot = createRoot(root)
    await act(async () => {
      reactRoot.render(
        <ResizablePanelFrame
          rect={{ x: 20, y: 30, width: 400, height: 300 }}
          bounds={{ minWidth: 200, minHeight: 160 }}
          persistGeometry="connections_picker"
          onCommit={(rect) => commits.push({ x: rect.x, y: rect.y })}
          title="Connections Picker"
        >
          <div>content</div>
        </ResizablePanelFrame>,
      )
    })

    const header = root.querySelector<HTMLElement>('section > div')!
    const pointer = (type: string, x = 0, y = 0) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
      return event
    }
    await act(async () => {
      header.dispatchEvent(pointer('pointerdown', 100, 100))
      window.dispatchEvent(pointer('pointermove', 130, 145))
      window.dispatchEvent(new dom.window.PointerEvent('pointerup'))
    })

    expect(commits.at(-1)).toEqual({ x: 50, y: 75 })
    expect(JSON.parse(window.localStorage.getItem('connections_picker')!)).toMatchObject({ x: 50, y: 75 })
    act(() => reactRoot.unmount())
  })
})
