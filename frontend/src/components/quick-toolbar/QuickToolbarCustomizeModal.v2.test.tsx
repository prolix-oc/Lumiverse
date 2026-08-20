/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['HTMLElement', globalObject.HTMLElement],
  ['Element', globalObject.Element],
  ['Node', globalObject.Node],
  ['navigator', globalObject.navigator],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./QuickToolbarCustomizeModal.module.css', () => ({ default: cssProxy }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children?: ReactNode }) => <div data-modal="customize">{children}</div>,
}))
mock.module('@/components/shared/Toggle', () => ({
  Toggle: {
    Switch: ({
      checked,
      'aria-label': ariaLabel,
    }: {
      checked?: boolean
      'aria-label'?: string
    }) => <button type="button" aria-label={ariaLabel} aria-pressed={checked === true} />,
  },
}))
mock.module('@/lib/dndUiScale', () => ({
  useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  filterActionIds: (ids: string[]) => ids,
  filterActions: (actions: unknown[]) => actions,
}))
mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children?: ReactNode }) => children,
  closestCenter: () => null,
  KeyboardSensor: class {},
  MouseSensor: class {},
  TouchSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
}))
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => children,
  sortableKeyboardCoordinates: () => ({}),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}))

const settings = {
  enabled: true,
  variant: 'v2-settings-adjacent' as 'v1-free' | 'v2-settings-adjacent',
  visibleTabIds: ['chat.new'] as string[],
  iconOrder: ['chat.new'] as string[],
  iconSize: 20,
  labelVisible: false,
  labelTextSize: 11,
  scale: 1,
  orientation: 'horizontal' as 'horizontal' | 'vertical',
  rotationDeg: 0,
  opacity: 1,
  snapToEdge: false,
  resizeHandlesEnabled: false,
  rect: { x: 24, y: 24, width: 0, height: 0 },
  v2IconSize: 28,
  v2LabelTextSize: 11,
  v2LabelVisible: false,
  v2Density: 'comfortable',
  v2IconOnly: true,
  autoFitBounds: true,
  fillTopDockWidth: true,
  showNativeSelectMessages: true,
  opaqueToolbarBackdrop: false,
  quickToolbarPlacement: 'floating' as 'floating' | 'chat_top_dock',
}

const catalogActions = [{
  id: 'chat.new',
  label: 'chat.new',
  description: 'chat.new',
  icon: () => <span />,
  surface: { kind: 'command' as const },
  run: () => undefined,
}]

mock.module('./useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({
    settings,
    updateSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
    actionCatalog: catalogActions,
    actionById: new Map(catalogActions.map((action) => [action.id, action])),
    catalogOrder: catalogActions.map((action) => action.id),
    visibleIds: settings.visibleTabIds,
    orderedIds: settings.iconOrder,
    reorderActions: () => undefined,
    toggleAction: () => undefined,
    resetCurrentVariant: () => undefined,
  }),
}))

let createRoot: typeof CreateRoot
let QuickToolbarCustomizeModal: typeof import('./QuickToolbarCustomizeModal').default

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: QuickToolbarCustomizeModal } = await import('./QuickToolbarCustomizeModal'))
})

afterEach(() => {
  document.body.replaceChildren()
  settings.variant = 'v2-settings-adjacent'
  settings.quickToolbarPlacement = 'floating'
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

async function renderModal() {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(<QuickToolbarCustomizeModal onClose={() => undefined} />)
    await Promise.resolve()
  })
  return { host, root }
}

describe('QuickToolbarCustomizeModal V2', () => {
  test('floating V2 shows Auto-fit and full-screen fill, without free-float chrome', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    const { host, root } = await renderModal()

    expect(host.textContent).toContain('Auto-fit toolbar bounds to content')
    expect(host.textContent).toContain('Fill the entire top of the screen')
    expect(host.textContent).toContain('Keep chat top dock enabled while floating')
    expect(host.textContent).not.toContain('Fill chat top bar width')
    expect(host.textContent).not.toContain('Show select-messages on chat top bar')
    expect(host.textContent).not.toContain('Scale')
    expect(host.textContent).not.toContain('Rotation')
    expect(host.textContent).not.toContain('Snap to edge')
    expect(host.textContent).not.toContain('Resize handles')
    expect(host.textContent).not.toContain('Orientation')

    await act(async () => root.unmount())
  })

  test('docked V2 uses chat-top fill label and still omits Scale/Rotation/Snap/Resize/Orientation', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'chat_top_dock'
    const { host, root } = await renderModal()

    expect(host.textContent).toContain('Fill chat top bar width')
    expect(host.textContent).not.toContain('Keep chat top dock enabled while floating')
    expect(host.textContent).toContain('Show select-messages on chat top bar')
    expect(host.textContent).not.toContain('Fill the entire top of the screen')
    expect(host.textContent).not.toContain('Auto-fit toolbar bounds to content')
    expect(host.textContent).not.toContain('Scale')
    expect(host.textContent).not.toContain('Rotation')
    expect(host.textContent).not.toContain('Snap to edge')
    expect(host.textContent).not.toContain('Resize handles')
    expect(host.textContent).not.toContain('Orientation')

    await act(async () => root.unmount())
  })
})
