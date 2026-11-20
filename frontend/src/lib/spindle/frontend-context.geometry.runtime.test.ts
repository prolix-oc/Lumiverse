import { describe, expect, test } from 'bun:test'
import type { FrontendDomainAPI } from './frontend-domain-api'
import {
  createFrontendExtensionContext,
  createFrontendGeometryAPI,
  type FrontendDockPanelOptions,
  type FrontendFloatWidgetOptions,
} from './frontend-context'

function createContext() {
  const domain = {
    connections: {},
    chats: {},
    worldBooks: {},
    messages: {},
    tokens: {},
  } as unknown as FrontendDomainAPI
  return createFrontendExtensionContext({
    base: {
      ui: { existing: true },
      chats: { existing: true },
      messages: { existing: true },
    },
    state: {} as never,
    domain,
    onTeardown: () => () => {},
  })
}

describe('H6 frontend geometry runtime contract', () => {
  test('composes geometry without replacing existing UI members', () => {
    const context = createContext()
    const scale = context.ui.geometry.getUiScale()

    expect(context.ui.existing).toBe(true)
    expect(context.ui.geometry.toLayoutPx(125)).toBeCloseTo(125 / scale)
    expect(context.ui.geometry.layoutElementRect({
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40 }) as DOMRect,
    } as unknown as Element)).toEqual({
      x: 10 / scale,
      y: 20 / scale,
      width: 30 / scale,
      height: 40 / scale,
    })
  })

  test('exposes the H6 placement option widening locally', () => {
    const floatOptions: FrontendFloatWidgetOptions = {
      resizable: true,
      bounds: { minWidth: 280, minHeight: 200 },
      aspectLock: 3 / 4,
      persistGeometry: 'panel',
      mobileClamp: false,
      onGeometryCommit: () => {},
    }
    const dockOptions: FrontendDockPanelOptions = {
      edge: 'right',
      title: 'Geometry',
      size: 320,
      respectRequestedEdge: true,
      showCollapsedTitle: true,
      persistGeometry: 'panel',
      onGeometryCommit: () => {},
    }

    expect(floatOptions.resizable).toBe(true)
    expect(dockOptions.respectRequestedEdge).toBe(true)
    expect(dockOptions.showCollapsedTitle).toBe(true)
  })

  test('returns a disposer for the framework-free resize adapter', () => {
    const target = new EventTarget() as unknown as HTMLElement
    const dispose = createFrontendGeometryAPI().createResizeController(target, { handles: ['se'] })

    expect(dispose).toBeFunction()
    dispose()
  })

  test('binds resize pointerdown to the requested descendant handle', () => {
    const surface = new EventTarget() as EventTarget & HTMLElement
    const handle = new EventTarget() as EventTarget & HTMLElement
    Object.assign(surface, {
      querySelector: (selector: string) => selector === '[data-resize-handle="se"]' ? handle : null,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 400 }),
    })

    let surfacePointerDowns = 0
    let handlePointerDowns = 0
    const surfaceAdd = surface.addEventListener.bind(surface)
    const handleAdd = handle.addEventListener.bind(handle)
    surface.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'pointerdown') surfacePointerDowns += 1
      surfaceAdd(type, listener, options)
    }) as typeof surface.addEventListener
    handle.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'pointerdown') handlePointerDowns += 1
      handleAdd(type, listener, options)
    }) as typeof handle.addEventListener

    const dispose = createFrontendGeometryAPI().createResizeController(surface, { handles: ['se'] })

    expect(surfacePointerDowns).toBe(0)
    expect(handlePointerDowns).toBe(1)
    dispose()
  })
})
