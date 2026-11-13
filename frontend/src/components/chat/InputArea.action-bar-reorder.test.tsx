/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { QUICK_TOOLBAR_POINTER_HOLD_MS } from '@/components/quick-toolbar/quickToolbarDock'
import type { DrawerTabState, InputBarActionState } from '@/store/slices/spindle-placement'
import { isCoreOwnedComposerActionId, isExtensionComposerActionId } from './composerActionOwnership'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./InputArea.module.css', () => ({ default: cssProxy }))
mock.module('@/components/quick-toolbar/useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({ actionCatalog: [] }),
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children?: unknown }) => children }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Switch: () => null } }))
mock.module('@/lib/dndUiScale', () => ({
  DndContext: ({ children }: { children?: unknown }) => children,
  useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  canMoveWithinFiltered: () => false,
  filterActionIds: (ids: string[]) => ids,
  filterActions: (actions: unknown[]) => actions,
}))
mock.module('@/store', () => {
  const state = {
    messageSelectMode: false,
    selectedMessageIds: [] as string[],
    enableToolbarIconReorder: true,
    /** Live extension registrations the composer projection reads. */
    inputBarActions: [] as InputBarActionState[],
    drawerTabs: [] as DrawerTabState[],
    extensions: [] as Array<{ id: string; identifier: string; enabled: boolean; has_frontend: boolean }>,
    setMessageSelectMode(enabled: boolean) {
      this.messageSelectMode = enabled
      this.selectedMessageIds = []
    },
  }
  const useStore = ((selector: (value: typeof state) => unknown) => selector(state)) as typeof import('@/store').useStore
  useStore.getState = () => state as unknown as ReturnType<typeof useStore.getState>
  return { useStore }
})

let createRoot: typeof CreateRoot
let ComposerActionBarLive: typeof import('./InputAreaComposerBar').ComposerActionBarLive
let useComposerActionBar: typeof import('./InputAreaCustomizeModal').useComposerActionBar
let COMPOSER_ACTION_BAR_STORAGE_KEY: typeof import('./InputAreaCustomizeModal').COMPOSER_ACTION_BAR_STORAGE_KEY
let saveComposerActionBar: typeof import('./InputAreaCustomizeModal').saveComposerActionBar
let normalizeComposerActionBarState: typeof import('./InputAreaCustomizeModal').normalizeComposerActionBarState
let COMPOSER_ACTION_IDS: typeof import('./InputAreaCustomizeModal').COMPOSER_ACTION_IDS
let useStore: typeof import('@/store').useStore

const clicks: string[] = []

const FOREIGN_CONTRIBUTION = 'widget'
const FOREIGN_RUNTIME_ID = 'ext_owner:action:widget:9'
const FOREIGN_KEY = 'ext-action:["input","ext_owner","widget"]'
const LEGACY_FOREIGN_KEY = 'input-action:ext_owner:spindle:ext_owner:action:widget:7'
const SUITE_HALF = 'lumiverse_suite.lorebook.open_half'
const SUITE_PICKER = 'lumiverse_suite.connections_picker.open'

function foreignInputAction(): InputBarActionState {
  return {
    id: FOREIGN_RUNTIME_ID,
    contributionId: FOREIGN_CONTRIBUTION,
    extensionId: 'ext_owner',
    extensionName: 'Ext Owner',
    label: 'Widget',
    enabled: true,
    clickHandlers: new Set(),
  }
}

function Probe() {
  const bar = useComposerActionBar()
  return (
    <>
      <output data-testid="composer-order">{bar.order.join('|')}</output>
      <output data-testid="composer-hidden">{bar.hidden.join('|')}</output>
      <button data-testid="toggle-foreign" type="button" onClick={() => bar.toggle(FOREIGN_KEY)}>toggle foreign</button>
      <button data-testid="toggle-suite" type="button" onClick={() => bar.toggle(SUITE_HALF)}>toggle Suite</button>
      <button
        data-testid="two-edits"
        type="button"
        onClick={() => {
          bar.toggle(FOREIGN_KEY)
          bar.toggle('regen')
        }}
      >
        two edits
      </button>
      <button data-testid="stale-reorder" type="button" onClick={() => bar.reorder(['ghost:id', 'home'])}>stale reorder</button>
      <ComposerActionBarLive
        order={bar.order}
        isVisible={bar.isVisible}
        reorder={bar.reorder}
        enableReorder
        renderUnit={(id) => {
          if (id === 'home') {
            return (
              <>
                <button type="button" data-testid="home-btn" onClick={() => clicks.push('home')}>Home</button>
                <span data-testid="home-divider" />
              </>
            )
          }
          if (id === 'regen') {
            return <button type="button" data-testid="regen-btn" onClick={() => clicks.push('regen')}>Regen</button>
          }
          if (id === 'continue') {
            return <button type="button" data-testid="continue-btn" onClick={() => clicks.push('continue')}>Continue</button>
          }
          return <button type="button" data-testid={`${id}-btn`}>{id}</button>
        }}
      >
        <span data-spindle-mount="chat_actions" data-testid="spindle-slot" />
        <button type="button" aria-label="Customize composer" data-testid="customize-gear">gear</button>
      </ComposerActionBarLive>
    </>
  )
}

beforeAll(async () => {
  ;({ useStore } = await import('@/store'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ComposerActionBarLive } = await import('./InputAreaComposerBar'))
  ;({
    useComposerActionBar,
    COMPOSER_ACTION_BAR_STORAGE_KEY,
    saveComposerActionBar,
    normalizeComposerActionBarState,
    COMPOSER_ACTION_IDS,
  } = await import('./InputAreaCustomizeModal'))
})

afterEach(() => {
  document.body.replaceChildren()
  clicks.length = 0
  localStorage.removeItem(COMPOSER_ACTION_BAR_STORAGE_KEY)
  const state = useStore.getState()
  state.inputBarActions = []
  state.drawerTabs = []
  state.extensions = []
})

function installHoldClock() {
  const pending: Array<{ at: number; fn: () => void }> = []
  let now = 0
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    pending.push({ at: now + Number(ms ?? 0), fn })
    return pending.length
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    const index = Number(id) - 1
    if (pending[index]) pending[index].fn = () => undefined
  }) as typeof clearTimeout
  return {
    pending,
    flush(at: number) {
      now = at
      pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
    },
    restore() {
      globalThis.setTimeout = previousSetTimeout
      globalThis.clearTimeout = previousClearTimeout
    },
  }
}

describe('InputArea action bar live reorder', () => {
  test('projects reserved Suite keys when UUID metadata arrives and persists the next edit coherently', async () => {
    const suiteId = '8c778c95-b0b8-40cc-8187-23de0a3a0d3c'
    const namespacedHalf = `ext-action:["input","${suiteId}","${SUITE_HALF}"]`
    const namespacedPicker = `ext-action:["input","${suiteId}","${SUITE_PICKER}"]`
    const store = useStore.getState()
    store.inputBarActions = [SUITE_HALF, SUITE_PICKER].map((contributionId, index) => ({
      ...foreignInputAction(),
      id: `spindle:${suiteId}:action:${contributionId}:${index + 1}`,
      contributionId,
      extensionId: suiteId,
    }))
    const saved = JSON.stringify({
      order: [...COMPOSER_ACTION_IDS, namespacedHalf, namespacedPicker],
      hidden: [namespacedHalf],
    })
    localStorage.setItem(COMPOSER_ACTION_BAR_STORAGE_KEY, saved)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Probe />))
      expect(host.querySelector('[data-testid="composer-order"]')?.textContent).toContain(namespacedPicker)
      store.extensions = [{ id: suiteId, identifier: 'lumiverse_suite', enabled: true, has_frontend: true }] as typeof store.extensions
      await act(async () => root.render(<Probe />))
      expect(host.querySelector('[data-testid="composer-order"]')?.textContent)
        .toBe([...COMPOSER_ACTION_IDS, SUITE_HALF, SUITE_PICKER].join('|'))
      expect(host.querySelector('[data-testid="composer-hidden"]')?.textContent).toBe(SUITE_HALF)
      expect(localStorage.getItem(COMPOSER_ACTION_BAR_STORAGE_KEY)).toBe(saved)
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="toggle-suite"]')?.click())
      const persisted = JSON.parse(localStorage.getItem(COMPOSER_ACTION_BAR_STORAGE_KEY) ?? '{}')
      expect(persisted.order).toEqual([...COMPOSER_ACTION_IDS, SUITE_HALF, SUITE_PICKER])
      expect(persisted.hidden).toEqual([])
    } finally {
      await act(async () => root.unmount())
    }
  })

  test('hold completes before reorder, clicks work before hold, and wrappers stay exclusive', async () => {
    expect(QUICK_TOOLBAR_POINTER_HOLD_MS).toBe(500)
    saveComposerActionBar({
      order: ['home', 'regen', 'continue', 'selectMessages'],
      hidden: ['selectMessages'],
    })
    const clock = installHoldClock()
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    try {
      await act(async () => {
        root.render(<Probe />)
        await Promise.resolve()
      })

      const home = document.querySelector('[data-composer-action="home"]') as HTMLElement
      const regen = document.querySelector('[data-composer-action="regen"]') as HTMLElement
      const cont = document.querySelector('[data-composer-action="continue"]') as HTMLElement
      expect(home).toBeTruthy()
      expect(regen).toBeTruthy()
      expect(cont).toBeTruthy()
      expect(home.getAttribute('data-toolbar-action')).toBe('home')
      expect(regen.getAttribute('data-toolbar-action')).toBe('regen')
      expect(home.style.display).toBe('contents')
      expect(home.querySelector('[data-testid="home-btn"]')).toBeTruthy()
      expect(home.querySelector('[data-testid="home-divider"]')).toBeTruthy()
      expect(document.querySelector('[data-composer-action="selectMessages"]')).toBeNull()
      expect(document.querySelector('[data-testid="spindle-slot"]')?.closest('[data-composer-action]')).toBeNull()
      expect(document.querySelector('[data-testid="customize-gear"]')?.closest('[data-composer-action]')).toBeNull()
      expect(document.querySelector('[data-testid="spindle-slot"]')?.closest('[data-toolbar-action]')).toBeNull()
      expect(document.querySelector('[data-testid="customize-gear"]')?.closest('[data-toolbar-action]')).toBeNull()

      const regenBtn = document.querySelector('[data-testid="regen-btn"]') as HTMLElement
      regenBtn.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
      regenBtn.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }))
      regenBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual(['regen'])

      clicks.length = 0
      regenBtn.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 12 }))
      clock.flush(499)
      expect(regen.getAttribute('data-dragging')).toBeNull()
      await act(async () => {
        clock.flush(500)
      })
      expect(regen.getAttribute('data-dragging')).toBe('')
      await act(async () => {
        cont.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 12 }))
        regenBtn.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 12 }))
        regenBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(clicks).toEqual([])
      const persisted = JSON.parse(localStorage.getItem(COMPOSER_ACTION_BAR_STORAGE_KEY) ?? '{}') as { order: string[] }
      expect(persisted.order.slice(0, 3)).toEqual(['home', 'continue', 'regen'])
    } finally {
      clock.restore()
      await act(async () => root.unmount())
    }
  })

  test('reload reads the reordered composer blob and modal reorder still persists', async () => {
    saveComposerActionBar({
      order: ['home', 'continue', 'regen'],
      hidden: ['selectMessages', 'oneliner', 'persona', 'connections', 'altFields', 'addons', 'guides', 'quickReplies', 'tools', 'extras'],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect([...document.querySelectorAll('[data-composer-action]')].map((node) => node.getAttribute('data-composer-action'))).toEqual([
      'home',
      'continue',
      'regen',
      'connectionsPicker',
      'promptVariables',
    ])
    await act(async () => root.unmount())

    saveComposerActionBar({
      order: ['regen', 'home', 'continue'],
      hidden: ['selectMessages', 'oneliner', 'persona', 'connections', 'altFields', 'addons', 'guides', 'quickReplies', 'tools', 'extras'],
    })
    const host2 = document.createElement('div')
    document.body.append(host2)
    const root2: Root = createRoot(host2)
    await act(async () => {
      root2.render(<Probe />)
      await Promise.resolve()
    })
    expect([...document.querySelectorAll('[data-composer-action]')].map((node) => node.getAttribute('data-composer-action'))).toEqual([
      'regen',
      'home',
      'continue',
      'connectionsPicker',
      'promptVariables',
    ])
    await act(async () => root2.unmount())
  })

  test('classifies persisted Suite actions without yielding the native customizer', () => {
    expect(isCoreOwnedComposerActionId('chat.customize-composer')).toBe(true)
    expect(isExtensionComposerActionId('chat.customize-composer')).toBe(false)
    expect(isExtensionComposerActionId('lumiverse_suite.connections_picker.open')).toBe(true)
    expect(isExtensionComposerActionId('spindle:lumiverse_suite:open')).toBe(true)
    expect(isExtensionComposerActionId('promptVariables')).toBe(false)
    expect(isExtensionComposerActionId('continue')).toBe(false)
    // PR stable and ephemeral extension keys are extension-owned; native Council
    // tab/view aliases and the core composer stay native.
    expect(isExtensionComposerActionId(FOREIGN_KEY)).toBe(true)
    expect(isExtensionComposerActionId('ext-runtime:["input","ext_owner","ext_owner:action:widget:9"]')).toBe(true)
    expect(isExtensionComposerActionId('council')).toBe(false)
    expect(isExtensionComposerActionId('ooc')).toBe(false)
    expect(isExtensionComposerActionId('feedback')).toBe(false)
  })

  test('InputArea drops persisted Suite-owned extras while retaining native extras when Suite is off', async () => {
    const source = await Bun.file(new URL('./InputArea.tsx', import.meta.url)).text()

    expect(source).toContain('isCoreOwnedComposerActionId')
    expect(source).toMatch(/const extraId = fromComposerExtraId\(id\)[\s\S]*?if \(isCoreOwnedComposerActionId\(extraId\)\) return null[\s\S]*?if \(!hasLumiverseSuite && isExtensionComposerActionId\(extraId\)\) return null[\s\S]*?const action = qtActionById\.get\(extraId\)/)
    expect(source).toContain('if (!hasLumiverseSuite && isExtensionComposerActionId(id)) return null')
  })

  test('the single composer impersonate action follows a chat override or the global default', async () => {
    const inputAreaSource = await Bun.file(new URL('./InputArea.tsx', import.meta.url)).text()
    const settingsSource = await Bun.file(new URL('../modals/GroupSettingsModal.tsx', import.meta.url)).text()
    const globalSettingsSource = await Bun.file(new URL('../modals/SettingsModal.tsx', import.meta.url)).text()

    expect(inputAreaSource).toContain('handleImpersonate(impersonationMode)')
    expect(inputAreaSource).toContain('impersonationModeOverride ?? defaultImpersonationMode')
    expect(inputAreaSource).not.toContain("handleImpersonate('prompts')")
    expect(inputAreaSource).not.toContain("handleImpersonate('preset')")
    expect(inputAreaSource).not.toContain("handleImpersonate('oneliner')")
    expect(settingsSource).toContain('impersonation_mode: impersonationMode || null')
    expect(settingsSource).toContain('useGlobalImpersonationMode')
    expect(settingsSource).toContain('role="radiogroup"')
    expect(globalSettingsSource).toContain("setSetting('defaultImpersonationMode'")
  })
})
