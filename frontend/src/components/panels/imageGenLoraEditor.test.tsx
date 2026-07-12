import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useCallback, useState, type ComponentProps, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '../../i18n/locales/en/panels.json'
import shared from '../../i18n/locales/en/shared.json'
import type { ImageGenConnectionModelsResult, ImageGenConnectionProfile } from '../../types/api'
import type {
  DraftLoraEntry,
  LoraDiscoveryController,
  LoraDiscoveryState,
  LoraModelLoader,
  LoraModelOption,
} from './imageGenLoraEditor'

let createRoot: typeof CreateRoot


type ModelComboFieldProps = {
  label: string
  hint: string
  paramKey: string
  modelSubtype: string
  activeConnection: ImageGenConnectionProfile | null
  value: unknown
  onChange: (key: string, value: unknown) => void
  loadModels?: LoraModelLoader
}

let ModelComboField: (props: ModelComboFieldProps) => ReactNode
let LoraDiscoveryStatus: (props: { controller: LoraDiscoveryController; className?: string }) => ReactNode
let LoraRowsEditor: (props: {
  rows: DraftLoraEntry[]
  onChange: (rows: DraftLoraEntry[]) => void
  filenameOptions: Array<{ value: string; label: string; sublabel?: string }>
  supportsDiscovery: boolean
  discoveryState: LoraDiscoveryState
}) => ReactNode
let interpretLoraDiscoveryResult: (
  result: ImageGenConnectionModelsResult,
) => { loras: LoraModelOption[]; error: string | null }
let reorderDraftLoras: (
  entries: DraftLoraEntry[],
  activeId: string,
  overId: string | null,
) => DraftLoraEntry[]
let isKnownLoraDropTarget: (
  entries: DraftLoraEntry[],
  overId: string | null,
) => overId is string
let useLoraDiscovery: (
  activeConnection: ImageGenConnectionProfile | null,
  loadModels: LoraModelLoader,
  fallbackError: string,
) => LoraDiscoveryController
let formatLoraReorderAnnouncement: (
  kind: 'pickedUp' | 'moving' | 'dropped' | 'cancelled',
  rows: DraftLoraEntry[],
  activeId: string,
  overId: string | null,
  translate: (key: string, values: Record<string, unknown>) => string,
) => string

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}

if (!globalThis.ResizeObserver) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
}

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ImageGenPanel imports mapped-field labels that initialize the Vite-only locale loader.
// ModelComboField does not use mapped-field controls, so isolate that unrelated app dependency.
mock.module('@/lib/comfyui-mapped-fields', () => ({
  buildMappedFieldControls: () => [],
}))
mock.module('@/lib/loom/service', () => ({
  detectSupportedParamsFromProviders: () => new Set<string>(),
  getAvailableMacros: () => [],
}))
mock.module('@/store', () => ({
  useStore: Object.assign(() => undefined, { getState: () => ({}) }),
}))



const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

type ObservedDragEnd = {
  activeId: string
  overId: string | null
}

const observedDragEnds: ObservedDragEnd[] = []


type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type ModelLoadCall = {
  id: string
  subtype: string
  deferred: Deferred<ImageGenConnectionModelsResult>
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createDeferredLoader(): { loadModels: LoraModelLoader; calls: ModelLoadCall[] } {
  const calls: ModelLoadCall[] = []
  const loadModels: LoraModelLoader = (id, subtype) => {
    const deferred = createDeferred<ImageGenConnectionModelsResult>()
    calls.push({ id, subtype, deferred })
    return deferred.promise
  }
  return { loadModels, calls }
}

function profile(id: string, overrides: Partial<ImageGenConnectionProfile> = {}): ImageGenConnectionProfile {
  return {
    id,
    name: `Connection ${id}`,
    provider: 'swarmui',
    api_url: `http://${id}.example.test`,
    model: '',
    is_default: false,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

function draft(
  draftId: string,
  lora_name = '',
  weight_model = '1',
  weight_clip = '1',
): DraftLoraEntry {
  return { draftId, lora_name, weight_model, weight_clip }
}

function DiscoveryProbe({
  activeConnection,
  loadModels,
  fallbackError = 'Fallback discovery error',
}: {
  activeConnection: ImageGenConnectionProfile | null
  loadModels: LoraModelLoader
  fallbackError?: string
}) {
  const controller = useLoraDiscovery(activeConnection, loadModels, fallbackError)
  return (
    <section>
      <LoraDiscoveryStatus controller={controller} />
      <output data-testid="discovery-state">{controller.state}</output>
      <output data-testid="discovery-options">{controller.loras.map((option) => option.id).join('|')}</output>
    </section>
  )
}

function RowsProbe({
  initialRows,
  filenameOptions,
  supportsDiscovery,
  discoveryState,
  onRowsChange,
  rowsOverride,
}: {
  initialRows: DraftLoraEntry[]
  filenameOptions: Array<{ value: string; label: string; sublabel?: string }>
  supportsDiscovery: boolean
  discoveryState: LoraDiscoveryState
  onRowsChange?: (rows: DraftLoraEntry[]) => void
  rowsOverride?: DraftLoraEntry[]
}) {
  const [rows, setRows] = useState(initialRows)
  const editorRows = rowsOverride ?? rows
  const handleChange = useCallback((nextRows: DraftLoraEntry[]) => {
    setRows(nextRows)
    onRowsChange?.(nextRows)
  }, [onRowsChange])

  return (
    <>
      <LoraRowsEditor
        rows={editorRows}
        onChange={handleChange}
        filenameOptions={filenameOptions}
        supportsDiscovery={supportsDiscovery}
        discoveryState={discoveryState}
      />
      <output data-testid="row-values">{editorRows.map((row) => row.lora_name).join('|')}</output>
    </>
  )
}

function ModelComboProbe({
  activeConnection,
  loadModels,
  initialValue = '',
  onModelChange,
}: {
  activeConnection: ImageGenConnectionProfile | null
  loadModels: LoraModelLoader
  initialValue?: string
  onModelChange?: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)
  const handleChange = useCallback((_key: string, nextValue: unknown) => {
    const next = typeof nextValue === 'string' ? nextValue : ''
    setValue(next)
    onModelChange?.(next)
  }, [onModelChange])

  return (
    <>
      <ModelComboField
        label="LoRA model"
        hint="A test-only generic model field"
        paramKey="lora_model"
        modelSubtype="loras"
        activeConnection={activeConnection}
        value={value}
        onChange={handleChange}
        loadModels={loadModels}
      />
      <output data-testid="model-value">{value}</output>
    </>
  )
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  const rerender = async (nextNode: ReactNode) => {
    await act(async () => {
      root.render(<I18nextProvider i18n={englishI18n}>{nextNode}</I18nextProvider>)
      await Promise.resolve()
    })
  }

  await rerender(node)
  return { host, rerender }
}

async function settleDeferred<T>(deferred: Deferred<T>, value: T) {
  await act(async () => {
    deferred.resolve(value)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function rejectDeferred<T>(deferred: Deferred<T>, reason?: unknown) {
  await act(async () => {
    deferred.reject(reason)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 25))
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

async function focus(element: HTMLElement) {
  await act(async () => {
    element.focus()
    await Promise.resolve()
  })
}

async function press(element: HTMLElement, key: string, code: string): Promise<KeyboardEvent> {
  let event!: KeyboardEvent
  await act(async () => {
    event = new domWindow.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      code,
    })
    element.dispatchEvent(event)
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 25))
    await Promise.resolve()
    await Promise.resolve()
  })
  return event
}

function mockClientRect(element: Element, top: number, height = 80, left = 0, width = 480) {
  const rect = {
    x: left,
    y: top,
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
    toJSON: () => ({}),
  } as DOMRect
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  })
}

function sortableRow(handle: HTMLButtonElement): HTMLDivElement {
  const row = handle.parentElement?.parentElement?.parentElement
  expect(row).not.toBeNull()
  return row as HTMLDivElement
}

function positionSortableRows(count: number): HTMLButtonElement[] {
  const handles = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Reorder LoRA "]'))
  expect(handles).toHaveLength(count)
  const rows = handles.map(sortableRow)
  rows.forEach((row, index) => mockClientRect(row, 100 + index * 80))
  const list = rows[0]?.parentElement
  expect(list).not.toBeNull()
  mockClientRect(list!, 100, count * 80)
  return handles
}

function reorderStatus(): HTMLElement {
  return required<HTMLElement>('span[role="status"][aria-live="assertive"]')
}

async function waitForSensor(ms: number) {
  await act(async () => {
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, ms))
    await Promise.resolve()
  })
}

async function dispatchMouseSensorEvent(
  target: EventTarget,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  clientX: number,
  clientY: number,
) {
  await act(async () => {
    const event = new domWindow.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX,
      clientY,
    })
    target.dispatchEvent(event)
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 25))
    await Promise.resolve()
  })
}

function createTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend',
  target: EventTarget,
  clientX: number,
  clientY: number,
): TouchEvent {
  const touchTarget = target instanceof domWindow.Element ? target : document.body
  const touch = {
    identifier: 1,
    target: touchTarget,
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  } as unknown as Touch
  const touches = type === 'touchend' ? [] : [touch]

  return new domWindow.TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
    targetTouches: touches,
    changedTouches: [touch],
  })
}

async function dispatchTouchSensorEvent(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY: number,
  settle = true,
) {
  await act(async () => {
    target.dispatchEvent(createTouchEvent(type, target, clientX, clientY))
    if (settle) {
      await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 25))
    }
    await Promise.resolve()
  })
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus()
    const descriptor = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')
    descriptor?.set?.call(input, value)
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0))
  })
}

function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector)
  expect(element).not.toBeNull()
  return element!
}

function statusElement(): HTMLElement {
  return required<HTMLElement>('[role="status"]')
}

function outputValue(testId: string): string {
  return required<HTMLOutputElement>(`output[data-testid="${testId}"]`).value
}

function buttonWithText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => button.textContent?.trim() === text)
  expect(buttons).toHaveLength(1)
  return buttons[0]!
}

function humanText(): string {
  return document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}


beforeAll(async () => {
  // Deliberately dynamic: a static ReactDOM import captures unsupported input APIs
  // before this test installs JSDOM.
  ;({ createRoot } = await import('react-dom/client'))

  await englishI18n.use(initReactI18next).init({
    resources: { en: { panels, shared } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })


  // dnd-kit must load after JSDOM, and this wrapper is installed before the
  // editor module so the test can observe real sensor-generated end events.
  const dndKit = await import('@dnd-kit/core')
  const OriginalDndContext = dndKit.DndContext
  const useDndMonitor = dndKit.useDndMonitor
  function DragEndMonitor() {
    useDndMonitor({
      onDragEnd: ({ active, over }) => {
        observedDragEnds.push({
          activeId: String(active.id),
          overId: over === null ? null : String(over.id),
        })
      },
    })
    return null
  }
  function MonitoredDndContext({
    children,
    ...props
  }: ComponentProps<typeof OriginalDndContext>) {
    return (
      <OriginalDndContext {...props}>
        {children}
        <DragEndMonitor />
      </OriginalDndContext>
    )
  }
  mock.module('@dnd-kit/core', () => ({
    ...dndKit,
    DndContext: MonitoredDndContext,
  }))

  // dnd-kit reads browser globals as it evaluates modules. The targets must load
  // after JSDOM is installed so this test exercises real live-region behavior.
  ;({
    LoraDiscoveryStatus,
    LoraRowsEditor,
    formatLoraReorderAnnouncement,
    interpretLoraDiscoveryResult,
    isKnownLoraDropTarget,
    reorderDraftLoras,
    useLoraDiscovery,
  } = await import('./imageGenLoraEditor'))
  ;({ ModelComboField } = await import('./ImageGenPanel'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  // dnd-kit removes its activation click capture on a 50ms timer.
  await waitForSensor(60)
  observedDragEnds.length = 0
  document.body.replaceChildren()
})

describe('image generation LoRA editor behavior', () => {
  test('interprets service errors before model IDs and only reorders known whole entries', () => {
    const exactId = 'styles/ink/artist-v2.safetensors'
    expect(interpretLoraDiscoveryResult({
      provider: 'swarmui',
      models: [{ id: exactId, label: 'Artist v2' }],
      error: '  Provider rejected LoRA discovery  ',
    })).toEqual({ loras: [], error: 'Provider rejected LoRA discovery' })

    expect(interpretLoraDiscoveryResult({
      provider: 'swarmui',
      models: [{ id: exactId, label: 'Artist v2' }],
    })).toEqual({
      loras: [{ id: exactId, label: 'Artist v2' }],
      error: null,
    })

    const first = draft('draft-first', 'first.safetensors', '0.8', '0.7')
    const second = draft('draft-second', 'second.safetensors', '0.6', '0.5')
    const third = draft('draft-third', 'third.safetensors', '1.1', '1.0')
    const entries = [first, second, third]
    const reordered = reorderDraftLoras(entries, third.draftId, first.draftId)

    expect(reordered).toEqual([third, first, second])
    expect(reordered[0]).toBe(third)
    expect(reordered[1]).toBe(first)
    expect(reordered[2]).toBe(second)
    expect(reorderDraftLoras(entries, 'missing', first.draftId)).toBe(entries)
    expect(reorderDraftLoras(entries, first.draftId, 'missing')).toBe(entries)
    expect(reorderDraftLoras(entries, first.draftId, first.draftId)).toBe(entries)
    expect(reorderDraftLoras(entries, first.draftId, null)).toBe(entries)
    expect(isKnownLoraDropTarget(entries, null)).toBe(false)
    expect(isKnownLoraDropTarget(entries, 'missing')).toBe(false)
    expect(isKnownLoraDropTarget(entries, first.draftId)).toBe(true)
  })

  test('reports loading, service errors, rejection fallback, empty, and ready discovery states', async () => {
    const loader = createDeferredLoader()
    const connectionA = profile('connection-a')
    const rendered = await mount(<DiscoveryProbe activeConnection={connectionA} loadModels={loader.loadModels} />)

    expect(loader.calls).toHaveLength(1)
    expect(loader.calls[0]).toMatchObject({ id: 'connection-a', subtype: 'loras' })
    expect(outputValue('discovery-state')).toBe('loading')
    expect(statusElement().textContent).toBe('Loading LoRAs…')
    expect(statusElement().parentElement?.getAttribute('aria-busy')).toBe('true')
    expect(englishI18n.t('imageGenPanel.loraDiscoveryReady', { ns: 'panels', count: 1 })).toBe('1 LoRA loaded')

    await settleDeferred(loader.calls[0]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'must-not-surface.safetensors', label: 'Must not surface' }],
      error: '  Upstream logical failure  ',
    })

    expect(outputValue('discovery-state')).toBe('error')
    expect(outputValue('discovery-options')).toBe('')
    expect(statusElement().textContent).toBe('Failed to load LoRAs: Upstream logical failure')

    const retry = buttonWithText('Retry')
    await click(retry)
    expect(document.activeElement).toBe(statusElement().parentElement)
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[1]).toMatchObject({ id: 'connection-a', subtype: 'loras' })
    expect(outputValue('discovery-state')).toBe('loading')

    await rejectDeferred(loader.calls[1]!.deferred)
    expect(outputValue('discovery-state')).toBe('error')
    expect(statusElement().textContent).toBe('Failed to load LoRAs: Fallback discovery error')

    await click(buttonWithText('Retry'))
    expect(loader.calls).toHaveLength(3)
    await settleDeferred(loader.calls[2]!.deferred, { provider: 'swarmui', models: [] })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('')
    expect(statusElement().textContent).toBe('No LoRAs found on the active connection')

    const connectionB = profile('connection-b')
    await rendered.rerender(<DiscoveryProbe activeConnection={connectionB} loadModels={loader.loadModels} />)
    expect(outputValue('discovery-state')).toBe('loading')
    expect(outputValue('discovery-options')).toBe('')
    expect(loader.calls).toHaveLength(4)

    await settleDeferred(loader.calls[3]!.deferred, {
      provider: 'swarmui',
      models: [
        { id: 'styles/ink.safetensors', label: 'Ink' },
        { id: 'styles/line.safetensors', label: 'Line' },
      ],
    })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('styles/ink.safetensors|styles/line.safetensors')
    expect(statusElement().textContent).toBe('2 LoRAs loaded')
  })

  test('discovers SD API LoRAs instead of falling back to manual entry', async () => {
    const loader = createDeferredLoader()
    const sdApiConnection = profile('sdapi-connection', { provider: 'sdapi' })
    const rendered = await mount(<DiscoveryProbe activeConnection={sdApiConnection} loadModels={loader.loadModels} />)

    expect(loader.calls).toHaveLength(1)
    expect(loader.calls[0]).toMatchObject({ id: 'sdapi-connection', subtype: 'loras' })
    await settleDeferred(loader.calls[0]!.deferred, {
      provider: 'sdapi',
      models: [{ id: 'styles/sdapi-ink.safetensors', label: 'SD API Ink' }],
    })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('styles/sdapi-ink.safetensors')

    await rendered.rerender(
      <DiscoveryProbe
        activeConnection={profile('unsupported-connection', { provider: 'pollinations' })}
        loadModels={loader.loadModels}
      />,
    )
    expect(loader.calls).toHaveLength(1)
    expect(outputValue('discovery-state')).toBe('idle')
  })

  test('cancels an A result after the active connection switches to B', async () => {
    const loader = createDeferredLoader()
    const connectionA = profile('connection-a')
    const connectionB = profile('connection-b')
    const rendered = await mount(<DiscoveryProbe activeConnection={connectionA} loadModels={loader.loadModels} />)
    const firstRequest = loader.calls[0]!

    await rendered.rerender(<DiscoveryProbe activeConnection={connectionB} loadModels={loader.loadModels} />)
    expect(loader.calls).toHaveLength(2)
    expect(outputValue('discovery-state')).toBe('loading')
    expect(outputValue('discovery-options')).toBe('')

    await settleDeferred(loader.calls[1]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'connection-b/current.safetensors', label: 'Current B' }],
    })
    expect(outputValue('discovery-options')).toBe('connection-b/current.safetensors')

    await settleDeferred(firstRequest.deferred, {
      provider: 'swarmui',
      models: [{ id: 'connection-a/stale.safetensors', label: 'Stale A' }],
    })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('connection-b/current.safetensors')
  })

  test('treats a same-ID replaced connection object as a new discovery target', async () => {
    const loader = createDeferredLoader()
    const original = profile('connection-a', { api_url: 'http://before.example.test', updated_at: 1 })
    const replacement = profile('connection-a', { api_url: 'http://after.example.test', updated_at: 2 })
    const rendered = await mount(<DiscoveryProbe activeConnection={original} loadModels={loader.loadModels} />)

    await settleDeferred(loader.calls[0]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'old-visible.safetensors', label: 'Old visible' }],
    })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('old-visible.safetensors')

    await rendered.rerender(<DiscoveryProbe activeConnection={replacement} loadModels={loader.loadModels} />)
    expect(outputValue('discovery-state')).toBe('loading')
    expect(outputValue('discovery-options')).toBe('')
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[1]).toMatchObject({ id: 'connection-a', subtype: 'loras' })

    await settleDeferred(loader.calls[1]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'new-visible.safetensors', label: 'New visible' }],
    })
    expect(outputValue('discovery-state')).toBe('ready')
    expect(outputValue('discovery-options')).toBe('new-visible.safetensors')
  })

  test('keeps manual LoRA entry editable in loading, error, and unsupported modes, then selects the exact discovered ID', async () => {
    const initialRows = [draft('opaque-row-id', '')]
    let latestRows = initialRows
    const onRowsChange = (rows: DraftLoraEntry[]) => {
      latestRows = rows
    }
    const rendered = await mount(
      <RowsProbe
        initialRows={initialRows}
        filenameOptions={[]}
        supportsDiscovery
        discoveryState="loading"
        onRowsChange={onRowsChange}
      />,
    )

    const manualInput = () => required<HTMLInputElement>('input[placeholder="Pick a LoRA… or type a filename"]')
    const selectTrigger = () => required<HTMLButtonElement>('button[aria-haspopup="listbox"]')

    expect(selectTrigger().disabled).toBe(true)
    expect(manualInput().disabled).toBe(false)
    await setInputValue(manualInput(), 'manual-loading.safetensors')
    expect(latestRows[0]?.lora_name).toBe('manual-loading.safetensors')

    await rendered.rerender(
      <RowsProbe
        initialRows={initialRows}
        filenameOptions={[]}
        supportsDiscovery
        discoveryState="error"
        onRowsChange={onRowsChange}
      />,
    )
    expect(manualInput().disabled).toBe(false)
    await setInputValue(manualInput(), 'manual-error.safetensors')
    expect(latestRows[0]?.lora_name).toBe('manual-error.safetensors')

    await rendered.rerender(
      <RowsProbe
        initialRows={initialRows}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={onRowsChange}
      />,
    )
    expect(document.querySelector('button[aria-haspopup="listbox"]')).toBeNull()
    expect(manualInput().disabled).toBe(false)
    await setInputValue(manualInput(), 'manual-unsupported.safetensors')
    expect(latestRows[0]?.lora_name).toBe('manual-unsupported.safetensors')

    const exactId = 'nested/styles/ink-v2.safetensors'
    await rendered.rerender(
      <RowsProbe
        initialRows={initialRows}
        filenameOptions={[{ value: exactId, label: 'Ink v2' }]}
        supportsDiscovery
        discoveryState="ready"
        onRowsChange={onRowsChange}
      />,
    )
    await click(selectTrigger())
    const option = required<HTMLButtonElement>('button[role="option"]')
    expect(option.textContent).toContain('Ink v2')
    await click(option)

    expect(manualInput().value).toBe(exactId)
    expect(latestRows[0]?.lora_name).toBe(exactId)
  })

  test('renders contextual sortable controls and localized human announcements without draft IDs', async () => {
    const first = draft('opaque-draft-id-first', 'named.safetensors', '0.8', '0.7')
    const blank = draft('opaque-draft-id-blank', '', '0.6', '0.5')
    const rows = [first, blank]
    const translate = (key: string, values: Record<string, unknown>) =>
      String(englishI18n.t(key, { ns: 'panels', ...values }))

    await mount(
      <RowsProbe
        initialRows={rows}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
      />,
    )

    const namedHandle = required<HTMLButtonElement>('button[aria-label="Reorder LoRA 1: named.safetensors"]')
    const blankHandle = required<HTMLButtonElement>('button[aria-label="Reorder LoRA 2: LoRA 2"]')
    expect(namedHandle.getAttribute('aria-disabled')).toBe('false')
    expect(blankHandle.getAttribute('aria-disabled')).toBe('false')
    expect(humanText()).toContain('Press Space to pick up a LoRA row. Use the arrow keys to move it, press Space to drop it, or press Escape to cancel.')
    expect(humanText()).not.toContain('opaque-draft-id-first')
    expect(humanText()).not.toContain('opaque-draft-id-blank')

    expect(
      formatLoraReorderAnnouncement('pickedUp', rows, blank.draftId, null, translate),
    ).toBe('Picked up LoRA 2, position 2 of 2.')
    expect(
      formatLoraReorderAnnouncement('moving', rows, blank.draftId, first.draftId, translate),
    ).toBe('Moving LoRA 2 to position 1 of 2.')
    expect(
      formatLoraReorderAnnouncement('dropped', rows, blank.draftId, first.draftId, translate),
    ).toBe('Dropped LoRA 2 at position 1 of 2.')
    expect(
      formatLoraReorderAnnouncement('cancelled', [blank, first], blank.draftId, null, translate),
    ).toBe('Reordering cancelled. LoRA 1 returned to position 1 of 2.')
  })

  test('leaves a single LoRA row handle focusable, aria-disabled, and unable to reorder', async () => {
    const single = draft('opaque-single-row-id', '')
    const changes: DraftLoraEntry[][] = []
    await mount(
      <RowsProbe
        initialRows={[single]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const handle = required<HTMLButtonElement>('button[aria-label="Reorder LoRA 1: LoRA 1"]')
    expect(handle.getAttribute('aria-disabled')).toBe('true')
    await focus(handle)
    expect(document.activeElement).toBe(handle)
    await press(handle, ' ', 'Space')
    expect(changes).toEqual([])
    expect(humanText()).not.toContain('opaque-single-row-id')
  })

  test('reorders complete draft rows through the actual keyboard sensor and announces each stage', async () => {
    const first = draft('018f8f9c-0001-7000-8000-000000000001', 'ink.safetensors', '0.8', '0.7')
    const second = draft('018f8f9c-0002-7000-8000-000000000002', 'line.safetensors', '0.6', '0.5')
    const third = draft('018f8f9c-0003-7000-8000-000000000003', 'color.safetensors', '1.1', '1.0')
    const changes: DraftLoraEntry[][] = []
    await mount(
      <RowsProbe
        initialRows={[first, second, third]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const [, , thirdHandle] = positionSortableRows(3)
    await focus(thirdHandle!)
    await press(thirdHandle!, ' ', 'Space')
    expect(reorderStatus().textContent).toBe('Picked up color.safetensors, position 3 of 3.')

    await press(thirdHandle!, 'ArrowUp', 'ArrowUp')
    expect(reorderStatus().textContent).toBe('Moving color.safetensors to position 2 of 3.')
    await press(thirdHandle!, 'ArrowUp', 'ArrowUp')
    expect(reorderStatus().textContent).toBe('Moving color.safetensors to position 1 of 3.')

    await press(thirdHandle!, ' ', 'Space')
    expect(reorderStatus().textContent).toBe('Dropped color.safetensors at position 1 of 3.')
    expect(changes).toEqual([[third, first, second]])
    expect(changes[0]).toEqual([
      { draftId: '018f8f9c-0003-7000-8000-000000000003', lora_name: 'color.safetensors', weight_model: '1.1', weight_clip: '1.0' },
      { draftId: '018f8f9c-0001-7000-8000-000000000001', lora_name: 'ink.safetensors', weight_model: '0.8', weight_clip: '0.7' },
      { draftId: '018f8f9c-0002-7000-8000-000000000002', lora_name: 'line.safetensors', weight_model: '0.6', weight_clip: '0.5' },
    ])
    expect(reorderStatus().textContent).not.toContain(first.draftId)
    expect(reorderStatus().textContent).not.toContain(second.draftId)
    expect(reorderStatus().textContent).not.toContain(third.draftId)
  })

  test('cancels a real keyboard sort with Escape without changing rows', async () => {
    const first = draft('cancel-first', 'ink.safetensors', '0.8', '0.7')
    const second = draft('cancel-second', 'line.safetensors', '0.6', '0.5')
    const third = draft('cancel-third', 'color.safetensors', '1.1', '1.0')
    const changes: DraftLoraEntry[][] = []
    await mount(
      <RowsProbe
        initialRows={[first, second, third]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const [firstHandle] = positionSortableRows(3)
    await focus(firstHandle!)
    await press(firstHandle!, ' ', 'Space')
    expect(reorderStatus().textContent).toContain('Picked up ink.safetensors, position 1 of 3.')
    await press(firstHandle!, 'ArrowDown', 'ArrowDown')
    expect(reorderStatus().textContent).toContain('Moving ink.safetensors to position 2 of 3.')

    await press(firstHandle!, 'Escape', 'Escape')
    expect(reorderStatus().textContent).toContain('Reordering cancelled. ink.safetensors returned to position 1 of 3.')
    expect(changes).toEqual([])
    expect(outputValue('row-values')).toBe('ink.safetensors|line.safetensors|color.safetensors')
  })

  test('reorders complete draft rows through the configured pointer-compatible mouse sensor', async () => {
    const first = draft('pointer-first', 'ink.safetensors', '0.8', '0.7')
    const second = draft('pointer-second', 'line.safetensors', '0.6', '0.5')
    const third = draft('pointer-third', 'color.safetensors', '1.1', '1.0')
    const changes: DraftLoraEntry[][] = []
    await mount(
      <RowsProbe
        initialRows={[first, second, third]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const [, secondHandle] = positionSortableRows(3)
    await dispatchMouseSensorEvent(secondHandle!, 'mousedown', 24, 220)
    await dispatchMouseSensorEvent(document, 'mousemove', 24, 226)
    expect(reorderStatus().textContent).toContain('Picked up line.safetensors, position 2 of 3.')
    await flushEffects()
    await dispatchMouseSensorEvent(document, 'mousemove', 24, 300)
    expect(reorderStatus().textContent).toContain('Moving line.safetensors to position 3 of 3.')
    await dispatchMouseSensorEvent(document, 'mouseup', 24, 300)

    expect(reorderStatus().textContent).toContain('Dropped line.safetensors at position 3 of 3.')
    expect(changes).toEqual([[first, third, second]])
    expect(changes[0]).toEqual([
      { draftId: 'pointer-first', lora_name: 'ink.safetensors', weight_model: '0.8', weight_clip: '0.7' },
      { draftId: 'pointer-third', lora_name: 'color.safetensors', weight_model: '1.1', weight_clip: '1.0' },
      { draftId: 'pointer-second', lora_name: 'line.safetensors', weight_model: '0.6', weight_clip: '0.5' },
    ])
  })

  test('does not call onChange or falsely announce a drop after an outside mouseup without sortable targets', async () => {
    const first = draft('outside-first', 'ink.safetensors', '0.8', '0.7')
    const second = draft('outside-second', 'line.safetensors', '0.6', '0.5')
    const changes: DraftLoraEntry[][] = []
    const rendered = await mount(
      <RowsProbe
        initialRows={[first, second]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const [firstHandle] = positionSortableRows(2)
    await dispatchMouseSensorEvent(firstHandle!, 'mousedown', 24, 140)
    await dispatchMouseSensorEvent(document, 'mousemove', 24, 146)
    expect(reorderStatus().textContent).toContain('Picked up ink.safetensors, position 1 of 2.')

    // closestCenter always chooses a registered row, so unmount every target
    // before the outside mouseup to exercise DndContext's real `over === null`
    // end path rather than invoking the handler directly.
    await rendered.rerender(
      <RowsProbe
        initialRows={[first, second]}
        rowsOverride={[]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )
    await flushEffects()
    await dispatchMouseSensorEvent(document, 'mousemove', 24, 1000)
    await dispatchMouseSensorEvent(document, 'mouseup', 24, 1000)

    expect(changes).toEqual([])
    expect(observedDragEnds).toEqual([{ activeId: first.draftId, overId: null }])
    expect(reorderStatus().textContent).not.toContain('Dropped')
  })

  test('reorders complete draft rows after the TouchSensor delay', async () => {
    const first = draft('touch-first', 'ink.safetensors', '0.8', '0.7')
    const second = draft('touch-second', 'line.safetensors', '0.6', '0.5')
    const third = draft('touch-third', 'color.safetensors', '1.1', '1.0')
    const changes: DraftLoraEntry[][] = []
    await mount(
      <RowsProbe
        initialRows={[first, second, third]}
        filenameOptions={[]}
        supportsDiscovery={false}
        discoveryState="idle"
        onRowsChange={(rows) => changes.push(rows)}
      />,
    )

    const [, , thirdHandle] = positionSortableRows(3)
    jest.useFakeTimers()
    try {
      await dispatchTouchSensorEvent(thirdHandle!, 'touchstart', 24, 300, false)
      expect(reorderStatus().textContent).toBe('')

      await act(async () => {
        jest.advanceTimersByTime(199)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(reorderStatus().textContent).toBe('')

      await act(async () => {
        jest.advanceTimersByTime(1)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(reorderStatus().textContent).toContain('Picked up color.safetensors, position 3 of 3.')

      await dispatchTouchSensorEvent(thirdHandle!, 'touchmove', 24, 140, false)
      expect(reorderStatus().textContent).toContain('Moving color.safetensors to position 1 of 3.')
      await dispatchTouchSensorEvent(thirdHandle!, 'touchend', 24, 140, false)

      expect(reorderStatus().textContent).toContain('Dropped color.safetensors at position 1 of 3.')
      expect(changes).toEqual([[third, first, second]])
      expect(changes[0]).toEqual([
        { draftId: 'touch-third', lora_name: 'color.safetensors', weight_model: '1.1', weight_clip: '1.0' },
        { draftId: 'touch-first', lora_name: 'ink.safetensors', weight_model: '0.8', weight_clip: '0.7' },
        { draftId: 'touch-second', lora_name: 'line.safetensors', weight_model: '0.6', weight_clip: '0.5' },
      ])
    } finally {
      jest.advanceTimersByTime(60)
      jest.useRealTimers()
    }
  })

  test('keeps generic model combobox errors isolated and preserves free text until selection', async () => {
    const loader = createDeferredLoader()
    const changes: string[] = []
    await mount(
      <ModelComboProbe
        activeConnection={profile('connection-a')}
        loadModels={loader.loadModels}
        initialValue="manual-model.safetensors"
        onModelChange={(value) => changes.push(value)}
      />,
    )

    const modelInput = () => required<HTMLInputElement>('input[placeholder="(workflow / connection default)"]')
    const refresh = () => required<HTMLButtonElement>('button[title]')

    await focus(modelInput())
    expect(loader.calls).toHaveLength(1)
    await rejectDeferred(loader.calls[0]!.deferred, new Error('Network request failed'))
    expect(humanText()).toContain('Network request failed')
    expect(modelInput().value).toBe('manual-model.safetensors')

    await click(refresh())
    expect(loader.calls).toHaveLength(2)
    expect(humanText()).not.toContain('Network request failed')
    await settleDeferred(loader.calls[1]!.deferred, {
      provider: 'swarmui',
      models: [],
      error: 'Provider returned a logical error',
    })
    expect(humanText()).toContain('Provider returned a logical error')
    expect(modelInput().value).toBe('manual-model.safetensors')

    await click(refresh())
    expect(loader.calls).toHaveLength(3)
    expect(humanText()).not.toContain('Provider returned a logical error')
    const exactId = 'nested/styles/ink-v2.safetensors'
    await settleDeferred(loader.calls[2]!.deferred, {
      provider: 'swarmui',
      models: [{ id: exactId, label: 'Ink v2' }],
    })
    expect(humanText()).not.toContain('Provider returned a logical error')
    expect(modelInput().value).toBe('manual-model.safetensors')

    await setInputValue(modelInput(), 'Ink')
    const exactOption = buttonWithText('Ink v2nested/styles/ink-v2.safetensors')
    await click(exactOption)
    expect(modelInput().value).toBe(exactId)
    expect(changes.at(-1)).toBe(exactId)
  })

  test('isolates generic model results across A to B and same-ID edited-A switches', async () => {
    const loader = createDeferredLoader()
    const originalA = profile('connection-a', { api_url: 'http://before.example.test', updated_at: 1 })
    const connectionB = profile('connection-b')
    const editedA = profile('connection-a', { api_url: 'http://after.example.test', updated_at: 2 })
    const rendered = await mount(<ModelComboProbe activeConnection={originalA} loadModels={loader.loadModels} />)
    const modelInput = () => required<HTMLInputElement>('input[placeholder="(workflow / connection default)"]')

    await focus(modelInput())
    expect(loader.calls).toHaveLength(1)
    const staleA = loader.calls[0]!

    await rendered.rerender(<ModelComboProbe activeConnection={connectionB} loadModels={loader.loadModels} />)
    expect(humanText()).not.toContain('Old A')
    await flushEffects()
    await act(async () => {
      modelInput().blur()
      modelInput().focus()
      await Promise.resolve()
    })
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[1]).toMatchObject({ id: 'connection-b', subtype: 'loras' })
    await settleDeferred(loader.calls[1]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'connection-b/current.safetensors', label: 'Current B' }],
    })
    expect(humanText()).toContain('Current B')

    await rendered.rerender(<ModelComboProbe activeConnection={editedA} loadModels={loader.loadModels} />)
    expect(humanText()).not.toContain('Current B')
    await flushEffects()
    await act(async () => {
      modelInput().blur()
      modelInput().focus()
      await Promise.resolve()
    })
    expect(loader.calls).toHaveLength(3)
    expect(loader.calls[2]).toMatchObject({ id: 'connection-a', subtype: 'loras' })

    await settleDeferred(staleA.deferred, {
      provider: 'swarmui',
      models: [{ id: 'connection-a/stale.safetensors', label: 'Old A' }],
    })
    expect(humanText()).not.toContain('Old A')
    expect(humanText()).not.toContain('Current B')

    await settleDeferred(loader.calls[2]!.deferred, {
      provider: 'swarmui',
      models: [{ id: 'connection-a/edited.safetensors', label: 'Edited A' }],
    })
    expect(humanText()).toContain('Edited A')
    expect(humanText()).not.toContain('Old A')
  })
})
