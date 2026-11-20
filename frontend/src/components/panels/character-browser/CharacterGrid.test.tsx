import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { Character, CharacterSummary } from '@/types/api'

let createRoot: typeof CreateRoot
let CharacterGrid: (props: CharacterGridProps) => ReactNode

type CharacterGridProps = {
  characters: CharacterSummary[]
  favorites: string[]
  batchMode: boolean
  batchSelected: string[]
  singleColumn?: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onEdit: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch: (id: string) => void
}

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLSpanElement: domWindow.HTMLSpanElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ResizeCallback = ResizeObserverCallback

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  emit(target: Element, width: number) {
    const contentRect = {
      x: 0,
      y: 0,
      top: 0,
      right: width,
      bottom: 0,
      left: 0,
      width,
      height: 0,
      toJSON: () => ({}),
    } as DOMRectReadOnly
    const entry = {
      target,
      contentRect,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }
}

Object.assign(globalThis, { ResizeObserver: TestResizeObserver })

const virtualizerCounts: number[] = []
const measure = jest.fn()

mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualizerCounts.push(count)
    return {
      getVirtualItems: () => (count > 0 ? [{ index: 0, key: 0, start: 0 }] : []),
      getTotalSize: () => 100,
      measureElement: () => {},
      measure,
    }
  },
}))

mock.module('@/hooks/useScrollGate', () => ({ useScrollGate: () => {} }))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrl: () => null,
  getCharacterAvatarThumbUrl: () => null,
}))
mock.module('@/lib/imageDecodeCache', () => ({ prefetchImages: () => {} }))
mock.module('@/lib/uiScale', () => ({ measureLayoutHeight: () => 100 }))
mock.module('./CharacterCard', () => ({
  default: ({ character }: { character: CharacterSummary }) => (
    <div data-character-card={character.id}>{character.name}</div>
  ),
}))

const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })

  return host
}

async function emitResize(observer: TestResizeObserver, target: Element, width: number) {
  await act(async () => {
    observer.emit(target, width)
    await Promise.resolve()
  })
}

function characters(count: number): CharacterSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `character-${index + 1}`,
    name: `Character ${index + 1}`,
  })) as CharacterSummary[]
}

function noop() {}

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: CharacterGrid } = await import('./CharacterGrid'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  TestResizeObserver.instances.length = 0
  virtualizerCounts.length = 0
  measure.mockClear()
})

describe('CharacterGrid theme column override', () => {
  test('keeps virtualizer row math synchronized with live --character-grid-columns changes', async () => {
    const host = await mount(
      <CharacterGrid
        characters={characters(10)}
        favorites={[]}
        batchMode={false}
        batchSelected={[]}
        onOpen={noop}
        onEdit={noop}
        onToggleFavorite={noop}
        onToggleBatch={noop}
      />,
    )

    const observer = TestResizeObserver.instances[0]!
    const scrollContainer = host.firstElementChild as HTMLDivElement
    const probe = host.querySelector<HTMLElement>('[data-character-grid-column-probe]')
    expect(observer).toBeDefined()
    expect(probe).not.toBeNull()

    // Native desktop calculation at 900px is four columns.
    await emitResize(observer, scrollContainer, 900)
    let row = host.querySelector<HTMLElement>('[data-virtual-grid]')
    expect(row?.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    expect(host.querySelectorAll('[data-character-card]').length).toBe(4)
    expect(virtualizerCounts.at(-1)).toBe(3)

    // A theme-authored count replaces the native responsive count and updates
    // both the rendered tracks and the virtualizer's row count.
    scrollContainer.style.setProperty('--character-grid-columns', '3')
    await emitResize(observer, probe!, 3)
    row = host.querySelector<HTMLElement>('[data-virtual-grid]')
    expect(row?.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(host.querySelectorAll('[data-character-card]').length).toBe(3)
    expect(virtualizerCounts.at(-1)).toBe(4)

    // Removing the theme override hands control back to the native responsive
    // calculation without requiring the container itself to resize.
    scrollContainer.style.removeProperty('--character-grid-columns')
    await emitResize(observer, probe!, 0)
    row = host.querySelector<HTMLElement>('[data-virtual-grid]')
    expect(row?.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    expect(virtualizerCounts.at(-1)).toBe(3)
  })

  test('singleColumn stays authoritative over a theme-authored count', async () => {
    const host = await mount(
      <CharacterGrid
        characters={characters(6)}
        favorites={[]}
        batchMode={false}
        batchSelected={[]}
        singleColumn
        onOpen={noop}
        onEdit={noop}
        onToggleFavorite={noop}
        onToggleBatch={noop}
      />,
    )

    const observer = TestResizeObserver.instances[0]!
    const scrollContainer = host.firstElementChild as HTMLDivElement
    const probe = host.querySelector<HTMLElement>('[data-character-grid-column-probe]')
    await emitResize(observer, scrollContainer, 900)
    scrollContainer.style.setProperty('--character-grid-columns', '4')
    await emitResize(observer, probe!, 4)

    const row = host.querySelector<HTMLElement>('[data-virtual-grid]')
    expect(row?.style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))')
    expect(host.querySelectorAll('[data-character-card]').length).toBe(1)
    expect(virtualizerCounts.at(-1)).toBe(6)
  })

  test('ignores invalid theme values and preserves the responsive fallback', async () => {
    const host = await mount(
      <CharacterGrid
        characters={characters(8)}
        favorites={[]}
        batchMode={false}
        batchSelected={[]}
        onOpen={noop}
        onEdit={noop}
        onToggleFavorite={noop}
        onToggleBatch={noop}
      />,
    )

    const observer = TestResizeObserver.instances[0]!
    const scrollContainer = host.firstElementChild as HTMLDivElement
    const probe = host.querySelector<HTMLElement>('[data-character-grid-column-probe]')
    await emitResize(observer, scrollContainer, 500)
    scrollContainer.style.setProperty('--character-grid-columns', 'banana')
    await emitResize(observer, probe!, 0)

    const row = host.querySelector<HTMLElement>('[data-virtual-grid]')
    expect(row?.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    expect(virtualizerCounts.at(-1)).toBe(4)
  })
})
