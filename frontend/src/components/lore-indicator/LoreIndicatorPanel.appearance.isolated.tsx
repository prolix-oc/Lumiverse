/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

let LoreIndicatorPanel: typeof import('./LoreIndicatorPanel').default
let LoreIndicator: typeof import('./LoreIndicator').default
let dom: JSDOM
let root: Root
let container: HTMLDivElement
let previousGlobals: Record<string, unknown>

const storeState = {
  extensions: [{ id: 'suite', enabled: true, has_frontend: true }],
  activatedWorldInfo: [{
    id: 'legacy-entry',
    comment: 'Legacy lore',
    keys: [],
    source: 'keyword',
    activationType: 'sticky',
    bookId: 'legacy-book',
    bookName: 'Legacy book',
    activationOrder: 0,
    firstTriggeredForBook: true,
    estimatedTokens: 18,
    priority: 0,
    position: 0,
    depth: 0,
    preventRecursion: false,
  }],
  worldInfoStats: { estimatedTokens: 18, recursionPassesUsed: 1, queryPreview: '' },
  worldInfoSettings: { maxTokenBudget: 100 },
  loreIndicatorSettings: {
    enabled: true,
    variant: 'v5-command-palette',
    v2ActivationMode: 'click',
    v2BookDisplay: 'grouped',
    v5Keybind: 'Ctrl+Shift+L',
    visibleMetadata: ['book', 'type', 'tokens', 'trigger'],
    iconSize: 16,
    textSize: 12,
    entryTypeAppearance: { constant: {}, sticky: undefined, keyword: undefined, vector: null },
    v4Items: [],
    v4Spacing: 8,
    v4GroupBy: 'lorebook',
    v4BookPreviewCount: 4,
    v5ShowShortcutHints: true,
  },
  lorebookEditorSettings: { loreIndicatorActionEnabled: false },
  inputBarActions: [] as Array<{
    extensionId: string
    enabled: boolean
    externallyInvocable?: boolean
    contributionId: string
    payloadVersion?: number
    clickHandlers: Set<(payload?: unknown) => void>
  }>,
  openLorebookHalfEditor: () => undefined,
  messages: [],
  setPendingWorldBookEditId: () => undefined,
  setPendingWorldBookEditEntryId: () => undefined,
  openDrawer: () => undefined,
}

mock.module('@/store', () => {
  const useStore = ((selector: (state: typeof storeState) => unknown) => selector(storeState)) as {
    <T>(selector: (state: typeof storeState) => T): T
    getState: () => typeof storeState
  }
  useStore.getState = () => storeState
  return { useStore }
})

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
  previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
  })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const elementPrototype = dom.window.HTMLElement.prototype as unknown as {
    attachEvent?: (eventName: string, listener: EventListener) => void
    detachEvent?: (eventName: string, listener: EventListener) => void
  }
  elementPrototype.attachEvent ??= () => {}
  elementPrototype.detachEvent ??= () => {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;({ default: LoreIndicatorPanel } = await import('./LoreIndicatorPanel'))
  ;({ default: LoreIndicator } = await import('./LoreIndicator'))
})

afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

describe('LoreIndicatorPanel legacy appearance settings', () => {
  test('renders populated entries when persisted appearance rows are malformed or missing', () => {
    act(() => root.render(<LoreIndicatorPanel mode="palette" />))

    expect(container.textContent).toContain('Legacy lore')
    expect(container.querySelectorAll('[data-activation="sticky"]')).not.toHaveLength(0)
  })

  test('opens a compact panel for a sticky entry with malformed persisted appearance settings', () => {
    storeState.loreIndicatorSettings.variant = 'v2-compact'

    act(() => root.render(<LoreIndicator />))
    const trigger = container.querySelector<HTMLButtonElement>('[title="Activated lore"]')
    expect(trigger).not.toBeNull()

    act(() => trigger?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))

    expect(document.body.textContent).toContain('Legacy lore')
    expect(document.body.querySelectorAll('[data-activation="sticky"]')).not.toHaveLength(0)
  })

  test('moves the V5 palette with valid positioned CSS and persists the dragged rect', () => {
    const previousVariant = storeState.loreIndicatorSettings.variant
    storeState.loreIndicatorSettings.variant = 'v5-command-palette'
    window.localStorage.setItem('lumiverse:lore-indicator:v5-rect', JSON.stringify({
      x: 100,
      y: 120,
      width: 600,
      height: 400,
    }))

    act(() => root.render(<LoreIndicator open />))
    const closeButton = document.body.querySelector<HTMLButtonElement>('[aria-label="Close lore command palette"]')
    const dragBar = closeButton?.parentElement
    const dialog = dragBar?.parentElement
    expect(dragBar).not.toBeNull()
    expect(dialog?.style.left).toBe('100px')
    expect(dialog?.style.top).toBe('120px')

    const pointerEvent = (type: string, clientX: number, clientY: number) => new dom.window.MouseEvent(type, {
      bubbles: true,
      clientX,
      clientY,
    })
    act(() => {
      dragBar?.dispatchEvent(pointerEvent('pointerdown', 20, 30))
      window.dispatchEvent(pointerEvent('pointermove', 60, 90))
      window.dispatchEvent(pointerEvent('pointerup', 60, 90))
    })

    expect(dialog?.style.left).toBe('140px')
    expect(dialog?.style.top).toBe('180px')
    expect(JSON.parse(window.localStorage.getItem('lumiverse:lore-indicator:v5-rect') ?? '')).toEqual({
      x: 140,
      y: 180,
      width: 600,
      height: 400,
    })
    storeState.loreIndicatorSettings.variant = previousVariant
  })

  test('V5 half editor detail action invokes the extension half workspace action', () => {
    const invoked: unknown[] = []
    storeState.lorebookEditorSettings.loreIndicatorActionEnabled = true
    storeState.inputBarActions = [{
      extensionId: 'suite',
      enabled: true,
      externallyInvocable: true,
      contributionId: 'lumiverse_suite.lorebook.open_half',
      payloadVersion: 1,
      clickHandlers: new Set<(payload?: unknown) => void>([(payload) => invoked.push(payload)]),
    }]

    act(() => root.render(<LoreIndicatorPanel mode="palette" />))
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Half editor')
    expect(button).not.toBeNull()

    act(() => button?.click())

    expect(invoked).toEqual([{
      version: 1,
      bookId: 'legacy-book',
      entryId: 'legacy-entry',
      source: 'half_editor',
      invocationId: 'lumiverse_suite.lorebook.open_half:lore-indicator:1',
    }])
    storeState.lorebookEditorSettings.loreIndicatorActionEnabled = false
    storeState.inputBarActions = []
  })
})
