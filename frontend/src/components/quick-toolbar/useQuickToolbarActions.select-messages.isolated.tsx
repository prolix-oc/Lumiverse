/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

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
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  quickToolbarSettings: {
    enabled: true,
    visibleTabIds: [] as string[],
    iconOrder: [] as string[],
    variant: 'v2-settings-adjacent',
  },
  user: null,
  drawerTabs: [],
  extensionCommands: [],
  inputBarActions: [],
  drawerOpen: false,
  drawerTab: '',
  settingsModalOpen: false,
  settingsActiveView: '',
  activeCharacterId: 'char-1',
  activeChatId: 'chat-1',
  isGroupChat: false,
  activeLoomPresetId: null,
  messageSelectMode: false,
  selectedMessageIds: ['msg-1'],
  openModal: () => undefined,
  openDrawer: () => undefined,
  closeDrawer: () => undefined,
  setDrawerTab: () => undefined,
  openSettings: () => undefined,
  closeSettings: () => undefined,
  setSetting: () => undefined,
  setMessageSelectMode(enabled: boolean) {
    this.messageSelectMode = enabled
    this.selectedMessageIds = []
  },
}

const useStore = ((selector: (value: typeof state) => unknown) => selector(state)) as typeof import('@/store').useStore
useStore.getState = () => state as unknown as ReturnType<typeof useStore.getState>

mock.module('@/store', () => ({ useStore }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'chatDocker.selectMessages.label': 'Select messages',
      'chatDocker.selectMessages.exitLabel': 'Exit selection mode',
    }[key] ?? key),
  }),
}))
mock.module('@/router', () => ({ router: { navigate: () => undefined } }))
mock.module('@/lib/commands', () => ({ COMMANDS: [] }))
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
let DESIGN_DEFAULT_IDS: typeof import('./useQuickToolbarActions').DESIGN_DEFAULT_IDS

function Probe() {
  const { actionCatalog, visibleIds, orderedIds } = useQuickToolbarActions()
  const select = actionCatalog.find((action) => action.id === 'chat.select-messages')
  return (
    <output
      data-testid="select-messages"
      data-active={select?.active === true ? 'true' : select?.active === false ? 'false' : 'missing'}
      data-label={select?.label ?? ''}
      data-in-defaults={(DESIGN_DEFAULT_IDS as readonly string[]).includes('chat.select-messages') ? 'true' : 'false'}
      data-visible={visibleIds.includes('chat.select-messages') ? 'true' : 'false'}
      data-ordered={orderedIds.includes('chat.select-messages') ? 'true' : 'false'}
    />
  )
}

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useQuickToolbarActions, DESIGN_DEFAULT_IDS } = await import('./useQuickToolbarActions'))
})

afterEach(() => {
  document.body.replaceChildren()
  state.messageSelectMode = false
  state.selectedMessageIds = ['msg-1']
  state.quickToolbarSettings.visibleTabIds = []
  state.quickToolbarSettings.iconOrder = []
})

describe('useQuickToolbarActions select-messages contract', () => {
  test('exposes chat.select-messages without adding it to untouched defaults', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    const node = host.querySelector('[data-testid="select-messages"]')
    expect(node).toBeTruthy()
    expect(node?.getAttribute('data-label')).toBe('Select messages')
    expect(node?.getAttribute('data-active')).toBe('false')
    expect(node?.getAttribute('data-in-defaults')).toBe('false')
    expect(node?.getAttribute('data-visible')).toBe('false')
    expect(node?.getAttribute('data-ordered')).toBe('false')
    expect(DESIGN_DEFAULT_IDS).not.toContain('chat.select-messages')

    await act(async () => root.unmount())
  })

  test('reacts to configured visibility and messageSelectMode for label and active state', async () => {
    state.quickToolbarSettings.visibleTabIds = ['chat.select-messages']
    state.quickToolbarSettings.iconOrder = ['chat.select-messages']
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    const node = host.querySelector('[data-testid="select-messages"]')
    expect(node?.getAttribute('data-active')).toBe('false')
    expect(node?.getAttribute('data-label')).toBe('Select messages')
    expect(node?.getAttribute('data-visible')).toBe('true')
    expect(node?.getAttribute('data-ordered')).toBe('true')

    state.messageSelectMode = true
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    expect(node?.getAttribute('data-active')).toBe('true')
    expect(node?.getAttribute('data-label')).toBe('Exit selection mode')
    expect(node?.getAttribute('data-visible')).toBe('true')
    expect(node?.getAttribute('data-ordered')).toBe('true')

    await act(async () => root.unmount())
  })
})
