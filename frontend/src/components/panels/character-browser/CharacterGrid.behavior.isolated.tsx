import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { CharacterSummary } from '../../../types/api'

let createRoot: typeof CreateRoot
let CharacterGrid: (props: CharacterGridProps) => ReactNode

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const nativeGetComputedStyle = domWindow.getComputedStyle.bind(domWindow)

const layoutVars = {
  minWidth: 260,
  gap: 28,
  height: 360,
}

function computedStyleWithLayoutVars(element: Element, pseudoElement?: string | null) {
  const style = nativeGetComputedStyle(element, pseudoElement)
  return new Proxy(style, {
    get(target, property, receiver) {
      if (property === 'getPropertyValue') {
        return (name: string) => {
          if (name === '--character-card-min-width') return `${layoutVars.minWidth}px`
          if (name === '--character-card-gap') return `${layoutVars.gap}px`
          if (name === '--character-card-height') return `${layoutVars.height}px`
          return target.getPropertyValue(name)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

Object.assign(domWindow, { getComputedStyle: computedStyleWithLayoutVars })
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLDivElement: domWindow.HTMLDivElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  SVGElement: domWindow.SVGElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: computedStyleWithLayoutVars,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type CharacterGridProps = {
  characters: CharacterSummary[]
  favorites: string[]
  batchMode: boolean
  batchSelected: string[]
  singleColumn?: boolean
  onOpen: (character: CharacterSummary) => void
  onEdit: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch: (id: string) => void
}

type ResizeTriggerEntry = { target: Element; width: number }

const resizeObservers: TestResizeObserver[] = []
class TestResizeObserver {
  readonly observed: Element[] = []
  readonly callback: ResizeObserverCallback
  readonly observe = jest.fn((target: Element) => {
    this.observed.push(target)
  })
  readonly disconnect = jest.fn()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.push(this)
  }

  trigger(entries: ResizeTriggerEntry[]) {
    const observerEntries = entries.map(({ target, width }) => ({
      target,
      contentRect: { width, height: 0 } as DOMRectReadOnly,
    })) as ResizeObserverEntry[]
    this.callback(observerEntries, this as unknown as ResizeObserver)
  }
}

Object.assign(domWindow, { ResizeObserver: TestResizeObserver })
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })

type VirtualRow = {
  index: number
  key: string
  start: number
  end: number
  size: number
  lane: number
}

type VirtualizerOptions = {
  count: number
  estimateSize: (index: number) => number
  measureElement: (element: Element) => unknown
  paddingStart: number
  [key: string]: unknown
}

let visibleRows: VirtualRow[] = []
let latestOptions: VirtualizerOptions | null = null
const measure = jest.fn()
const measureElement = jest.fn()
const getVirtualItems = jest.fn(() => visibleRows)
const getTotalSize = jest.fn(() => 4096)
const virtualizer = {
  getVirtualItems,
  getTotalSize,
  measure,
  measureElement,
}
const useVirtualizer = jest.fn((options: VirtualizerOptions) => {
  latestOptions = options
  return virtualizer
})

const prefetchImages = jest.fn()
const isImageDecoded = jest.fn(() => false)
const onImageDecoded = jest.fn((_url: string, _listener: () => void) => () => {})
const rememberImageDecoded = jest.fn()
const measureLayoutHeight = jest.fn(() => 0)
const useScrollGate = jest.fn()

const moduleClassNames = new Proxy<Record<string, string>>({} as Record<string, string>, {
  get: (_target, key) => String(key),
})

mock.module('@tanstack/react-virtual', () => ({ useVirtualizer }))
mock.module('@/hooks/useScrollGate', () => ({ useScrollGate }))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrl: (character: CharacterSummary) => `large:${character.id}`,
  getCharacterAvatarThumbUrl: (character: CharacterSummary) => `thumb:${character.id}`,
}))
mock.module('@/lib/imageDecodeCache', () => ({
  prefetchImages,
  isImageDecoded,
  onImageDecoded,
  rememberImageDecoded,
}))
mock.module('@/lib/uiScale', () => ({ measureLayoutHeight }))
mock.module('./CharacterGrid.module.css', () => ({ default: moduleClassNames }))
mock.module('./CharacterCard.module.css', () => ({ default: moduleClassNames }))

const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

function character(index: number): CharacterSummary {
  return {
    id: `character-${index}`,
    name: `Character ${index}`,
    description: `Description ${index}`,
    preview_description: `Description ${index}`,
    creator: 'Test creator',
    folder: '',
    tags: ['test'],
    image_id: `image-${index}`,
    library_scope: 'mine',
    created_at: index,
    updated_at: index,
    has_alternate_greetings: false,
  }
}

function currentOptions(): VirtualizerOptions {
  if (!latestOptions) throw new Error('CharacterGrid did not configure its virtualizer')
  return latestOptions
}

function row(index: number): VirtualRow {
  return {
    index,
    key: `row-${index}`,
    start: index * 100,
    end: index * 100 + 100,
    size: 100,
    lane: 0,
  }
}

function setClientWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width })
}

function entry(target: Element, width: number): ResizeTriggerEntry {
  return { target, width }
}

async function resize(entries: ResizeTriggerEntry[]) {
  const observer = resizeObservers[0]
  if (!observer) throw new Error('CharacterGrid did not create a ResizeObserver')
  await act(async () => {
    observer.trigger(entries)
    await Promise.resolve()
  })
}

async function mountGrid(characters: CharacterSummary[]) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const mounted = { root, host }
  mountedRoots.push(mounted)

  await act(async () => {
    root.render(
      <I18nextProvider i18n={englishI18n}>
        <CharacterGrid
          characters={characters}
          favorites={[]}
          batchMode={false}
          batchSelected={[]}
          onOpen={jest.fn()}
          onEdit={jest.fn()}
          onToggleFavorite={jest.fn()}
          onToggleBatch={jest.fn()}
        />
      </I18nextProvider>,
    )
    await Promise.resolve()
  })

  return mounted
}

async function unmountGrid(mounted: { root: Root; host: HTMLDivElement }) {
  const index = mountedRoots.indexOf(mounted)
  if (index >= 0) mountedRoots.splice(index, 1)
  await act(async () => {
    mounted.root.unmount()
  })
}

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { panels: {} } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: CharacterGrid } = await import('./CharacterGrid'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()

  resizeObservers.splice(0)
  visibleRows = [row(0)]
  latestOptions = null
  Object.assign(layoutVars, { minWidth: 260, gap: 28, height: 360 })
  measure.mockReset()
  measureElement.mockReset()
  getVirtualItems.mockClear()
  getTotalSize.mockClear()
  useVirtualizer.mockClear()
  prefetchImages.mockReset()
  isImageDecoded.mockReset().mockReturnValue(false)
  onImageDecoded.mockReset().mockImplementation((_url: string, _listener: () => void) => () => {})
  rememberImageDecoded.mockReset()
  measureLayoutHeight.mockReset().mockReturnValue(0)
  useScrollGate.mockReset()
})

describe('CharacterGrid responsive geometry', () => {
  test('uses custom desktop min width, gap, and fixed height', async () => {
    visibleRows = [row(0)]
    const mounted = await mountGrid(Array.from({ length: 8 }, (_, index) => character(index)))
    const scrollContainer = mounted.host.querySelector('.scrollContainer') as HTMLElement
    const geometryProbe = mounted.host.querySelector('.geometryProbe') as HTMLElement
    const observer = resizeObservers[0]

    await resize([entry(scrollContainer, 900)])

    const renderedRow = mounted.host.querySelector('[data-index="0"]') as HTMLElement
    expect(renderedRow.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(renderedRow.style.gap).toBe('28px')
    expect(renderedRow.style.paddingLeft).toBe('14px')
    expect(renderedRow.style.paddingRight).toBe('14px')
    expect(renderedRow.style.paddingBottom).toBe('28px')
    expect(currentOptions().count).toBe(3)
    expect(currentOptions().paddingStart).toBe(28)
    expect(currentOptions().estimateSize(0)).toBe(388)
    expect(observer.observed).toContain(scrollContainer)
    expect(observer.observed).toContain(geometryProbe)
  })

  test('keeps mobile cards at min 140px, gap 12px, and at most two columns', async () => {
    visibleRows = [row(0)]
    const mounted = await mountGrid(Array.from({ length: 9 }, (_, index) => character(index)))
    const scrollContainer = mounted.host.querySelector('.scrollContainer') as HTMLElement

    await resize([entry(scrollContainer, 500)])
    let renderedRow = mounted.host.querySelector('[data-index="0"]') as HTMLElement
    expect(renderedRow.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    expect(renderedRow.style.gap).toBe('12px')
    expect(renderedRow.style.paddingLeft).toBe('6px')
    expect(currentOptions().count).toBe(5)
    expect(currentOptions().paddingStart).toBe(12)

    await resize([entry(scrollContainer, 280)])
    renderedRow = mounted.host.querySelector('[data-index="0"]') as HTMLElement
    expect(renderedRow.style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))')
    expect(renderedRow.style.gap).toBe('12px')
    expect(currentOptions().count).toBe(9)
  })

  test('remeasures the virtualizer when the observed geometry variables change', async () => {
    visibleRows = [row(0)]
    const mounted = await mountGrid(Array.from({ length: 12 }, (_, index) => character(index)))
    const scrollContainer = mounted.host.querySelector('.scrollContainer') as HTMLElement
    const geometryProbe = mounted.host.querySelector('.geometryProbe') as HTMLElement
    setClientWidth(scrollContainer, 900)

    await resize([entry(scrollContainer, 900)])
    const beforeMeasure = measure.mock.calls.length
    const beforeOptions = currentOptions()
    expect(measureElement.mock.calls.some(([element]) => element instanceof domWindow.HTMLElement)).toBe(true)

    Object.assign(layoutVars, { minWidth: 280, gap: 32, height: 420 })
    await resize([entry(geometryProbe, 0)])

    const renderedRow = mounted.host.querySelector('[data-index="0"]') as HTMLElement
    expect(renderedRow.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    expect(renderedRow.style.gap).toBe('32px')
    expect(currentOptions().paddingStart).toBe(32)
    expect(currentOptions().estimateSize(0)).toBe(452)
    expect(measure.mock.calls.length).toBeGreaterThan(beforeMeasure)
  })
})

describe('CharacterGrid prefetch and cleanup', () => {
  test('prefetches exactly six rows on either side of the visible range', async () => {
    visibleRows = [row(3), row(4)]
    Object.assign(layoutVars, { minWidth: 220, gap: 20, height: 0 })
    const mounted = await mountGrid(Array.from({ length: 60 }, (_, index) => character(index)))
    const scrollContainer = mounted.host.querySelector('.scrollContainer') as HTMLElement
    prefetchImages.mockReset()

    await resize([entry(scrollContainer, 900)])

    const calls = prefetchImages.mock.calls
    const urls = calls[calls.length - 1]?.[0] as string[] | undefined
    expect(urls).toHaveLength(33)
    expect(urls?.[0]).toBe('large:character-0')
    expect(urls?.[32]).toBe('large:character-32')
    expect(urls).not.toContain('large:character-33')
  })

  test('disconnects its ResizeObserver when unmounted', async () => {
    const mounted = await mountGrid([character(0)])
    const observers = resizeObservers.slice()

    await unmountGrid(mounted)

    expect(observers).toHaveLength(1)
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
  })
})
