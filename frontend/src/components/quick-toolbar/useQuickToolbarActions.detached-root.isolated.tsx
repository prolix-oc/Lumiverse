/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { Columns2, Maximize2, Waypoints } from 'lucide-react'
import type { InputBarActionState } from '@/store/slices/spindle-placement'

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

const state = {
  quickToolbarSettings: {
    enabled: true,
    visibleTabIds: ['settings', 'command:action-home'],
    iconOrder: ['settings', 'command:action-home'],
    variant: 'v2-settings-adjacent',
  },
  user: null,
  drawerTabs: [],
  extensionCommands: [],
  extensions: [{ id: 'lumiverse_suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }],
  inputBarActions: [] as InputBarActionState[],
  drawerOpen: false,
  drawerTab: '',
  settingsModalOpen: false,
  settingsActiveView: '',
  openDrawer: () => undefined,
  closeDrawer: () => undefined,
  setDrawerTab: () => undefined,
  openSettings: () => undefined,
  closeSettings: () => undefined,
  setSetting: (key: string, value: unknown) => {
    settingWrites.push({ key, value })
    if (key === 'quickToolbarSettings') state.quickToolbarSettings = value as typeof state.quickToolbarSettings
  },
}
const settingWrites: Array<{ key: string; value: unknown }> = []
const useStore = ((selector: (value: typeof state) => unknown) => selector(state)) as typeof import('@/store').useStore
useStore.getState = () => state as unknown as ReturnType<typeof useStore.getState>

mock.module('@/store', () => ({ useStore }))
mock.module('@/router', () => ({ router: { navigate: () => undefined } }))
mock.module('@/lib/commands', () => ({
  COMMANDS: [{
    id: 'action-home',
    label: 'Home',
    description: 'Go home',
    keywords: [],
    group: 'actions',
    icon: () => null,
    run: () => undefined,
  }],
}))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: [],
  adaptExtensionTabs: () => [],
  extensionCommandsToCommands: () => [],
}))
mock.module('@/lib/settings-tab-registry', () => ({ getVisibleSettingsTabs: () => [] }))
mock.module('@/lib/quickToolbarToggle', () => ({
  resolveToolbarIntent: () => ({ type: 'run-command' }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({ moveWithinFiltered: (ids: string[]) => ids }))
mock.module('@/lib/uiProductivityDefaults', () => ({
  DEFAULT_QUICK_TOOLBAR_SETTINGS: state.quickToolbarSettings,
}))

let createRoot: typeof CreateRoot
let useQuickToolbarActions: typeof import('./useQuickToolbarActions').useQuickToolbarActions
let isQuickToolbarInputAction: typeof import('./useQuickToolbarActions').isQuickToolbarInputAction
let quickToolbarInputActionId: typeof import('./useQuickToolbarActions').quickToolbarInputActionId
let quickToolbarInputActionIcon: typeof import('./useQuickToolbarActions').quickToolbarInputActionIcon
let quickToolbarInputActionLabel: typeof import('./useQuickToolbarActions').quickToolbarInputActionLabel

function Probe() {
  const { actions, toggleAction } = useQuickToolbarActions()
  return <>
    <output data-testid="toolbar-action-count">{actions.length}</output>
    {actions.map((action) => {
      const Icon = action.icon
      return <output key={action.id} data-action-id={action.id}><Icon size={16} /><span>{action.label}</span></output>
    })}
    <button data-testid="toggle-home" type="button" onClick={() => toggleAction('command:action-home')}>toggle home</button>
    <button data-testid="toggle-half" type="button" onClick={() => toggleAction('lumiverse_suite.lorebook.open_half')}>toggle half</button>
    <button data-testid="run-half" type="button" onClick={() => actions.find((action) => action.id === 'lumiverse_suite.lorebook.open_half')?.run()}>run half</button>
    <button data-testid="run-connections" type="button" onClick={() => actions.find((action) => action.id === 'lumiverse_suite.connections_picker.open')?.run()}>run connections</button>
  </>
}

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useQuickToolbarActions, isQuickToolbarInputAction, quickToolbarInputActionId, quickToolbarInputActionIcon, quickToolbarInputActionLabel } = await import('./useQuickToolbarActions'))
})

afterEach(() => document.body.replaceChildren())

describe('useQuickToolbarActions detached host root', () => {
  test('renders its action catalog without a Router provider', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="toolbar-action-count"]')?.textContent).toBe('2')

    await act(async () => root.unmount())
  })

  test('persists a toolbar edit through the canonical store writer', async () => {
    settingWrites.length = 0
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-home"]')?.click()
      await Promise.resolve()
    })

    expect(settingWrites.at(-1)).toMatchObject({ key: 'quickToolbarSettings' })
    expect((settingWrites.at(-1)?.value as typeof state.quickToolbarSettings).visibleTabIds).not.toContain('command:action-home')

    await act(async () => root.unmount())
  })

  test('allowlists the Lumiverse extension actions with stable ids and glyphs', () => {
    const half = {
      id: 'lumiverse_suite:action:lumiverse_suite.lorebook.open_half:1',
      contributionId: 'lumiverse_suite.lorebook.open_half',
      extensionId: 'lumiverse_suite',
      placement: 'world_book.entry_toolbar',
    }
    const enhanced = {
      id: 'lumiverse_suite:action:lumiverse_suite.lorebook.open_enhanced:2',
      contributionId: 'lumiverse_suite.lorebook.open_enhanced',
      extensionId: 'lumiverse_suite',
      placement: 'world_book.entry_toolbar',
    }
    const native = {
      id: 'native-world-book-editor',
      contributionId: 'worldBookEditor',
      extensionId: 'core',
      placement: 'world_book.entry_toolbar',
    }
    const connectionsPicker = {
      id: 'lumiverse_suite:action:lumiverse_suite.connections_picker.open:3',
      contributionId: 'lumiverse_suite.connections_picker.open',
      extensionId: 'lumiverse_suite',
      placement: 'quick_toolbar',
    }

    expect(isQuickToolbarInputAction(half)).toBe(true)
    expect(isQuickToolbarInputAction(enhanced)).toBe(true)
    expect(isQuickToolbarInputAction(connectionsPicker)).toBe(true)
    expect(isQuickToolbarInputAction(native)).toBe(false)
    expect(quickToolbarInputActionId(half)).toBe('lumiverse_suite.lorebook.open_half')
    expect(quickToolbarInputActionId(enhanced)).toBe('lumiverse_suite.lorebook.open_enhanced')
    expect(quickToolbarInputActionId(connectionsPicker)).toBe('lumiverse_suite.connections_picker.open')
    expect(quickToolbarInputActionIcon(half)).toBe(Columns2)
    expect(quickToolbarInputActionIcon(enhanced)).toBe(Maximize2)
    expect(quickToolbarInputActionIcon(connectionsPicker)).toBe(Waypoints)
    expect(quickToolbarInputActionLabel({ ...half, label: 'Open half editor' })).toBe('quickToolbar.halfScreenLorebook')
    expect(quickToolbarInputActionLabel({ ...enhanced, label: 'Open enhanced workspace' })).toBe('quickToolbar.fullScreenLorebook')
  })

  test('offers the Connections Picker action and invokes its extension handler', async () => {
    let opens = 0
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['lumiverse_suite.connections_picker.open'],
      iconOrder: ['lumiverse_suite.connections_picker.open'],
    }
    state.inputBarActions = [{
      id: 'lumiverse_suite:action:lumiverse_suite.connections_picker.open:3',
      contributionId: 'lumiverse_suite.connections_picker.open',
      extensionId: 'lumiverse_suite',
      extensionName: 'Lumiverse Suite',
      placement: 'quick_toolbar',
      label: 'Connections Picker',
      subtitle: 'Choose the active connection and model',
      iconName: 'waypoints',
      enabled: true,
      clickHandlers: new Set([() => { opens += 1 }]),
    }]
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(host.querySelector('[data-action-id="lumiverse_suite.connections_picker.open"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="run-connections"]')?.click()
      await Promise.resolve()
    })
    expect(opens).toBe(1)

    state.extensions[0].enabled = false
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="run-connections"]')?.click()
      await Promise.resolve()
    })
    expect(opens).toBe(1)

    await act(async () => root.unmount())
    state.extensions[0].enabled = true
    state.inputBarActions = []
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['settings', 'command:action-home'],
      iconOrder: ['settings', 'command:action-home'],
    }
  })
  test('catalog source gates Suite-owned composer actions when the extension is unavailable', async () => {
    const source = await Bun.file(new URL('./useQuickToolbarActions.ts', import.meta.url)).text()
    expect(source).toContain("hasEnabledFrontendExtension(extensions, 'lumiverse_suite')")
    expect(source).toContain('catalog.filter((action) => !isExtensionComposerActionId(action.id))')
  })
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})
