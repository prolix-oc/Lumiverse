/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { QUICK_TOOLBAR_POINTER_HOLD_MS } from '@/components/quick-toolbar/quickToolbarDock'

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
mock.module('@/lib/dndUiScale', () => ({ useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }) }))
mock.module('@/lib/toolbarActionSearch', () => ({
  filterActionIds: (ids: string[]) => ids,
  filterActions: (actions: unknown[]) => actions,
}))
mock.module('@/store', () => {
  const state = {
    messageSelectMode: false,
    selectedMessageIds: [] as string[],
    enableToolbarIconReorder: true,
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

const clicks: string[] = []

function Probe() {
  const bar = useComposerActionBar()
  return (
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
  )
}

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ComposerActionBarLive } = await import('./InputAreaComposerBar'))
  ;({
    useComposerActionBar,
    COMPOSER_ACTION_BAR_STORAGE_KEY,
    saveComposerActionBar,
  } = await import('./InputAreaCustomizeModal'))
})

afterEach(() => {
  document.body.replaceChildren()
  clicks.length = 0
  localStorage.removeItem(COMPOSER_ACTION_BAR_STORAGE_KEY)
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
  test('hold completes before reorder, clicks work before hold, and wrappers stay exclusive', async () => {
    expect(QUICK_TOOLBAR_POINTER_HOLD_MS).toBe(1000)
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
      clock.flush(999)
      expect(regen.getAttribute('data-dragging')).toBeNull()
      await act(async () => {
        clock.flush(1000)
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
    ])
    await act(async () => root2.unmount())
  })
})
