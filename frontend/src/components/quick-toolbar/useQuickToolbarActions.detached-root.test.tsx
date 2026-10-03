/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { Columns2, Maximize2, Waypoints } from 'lucide-react'
import type { DrawerTabState, InputBarActionState } from '@/store/slices/spindle-placement'

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

const HALF_CONTRIBUTION = 'lumiverse_suite.lorebook.open_half'
/** Real chat-docker catalog ids used for the search-filter subset case. */
const SUBSET_FIRST = 'chat.new'
const SUBSET_TARGET = 'chat.manage'
const SUBSET_LAST = 'chat.prompt-variables'

/**
 * Owner-enabled slice, shaped exactly as the store supplies it. Both owners that
 * register actions here are enabled, so the live unique maps and the rendered
 * catalog both admit their registrations; `filterEnabledFrontendContributions`
 * matches on `identifier ?? id`.
 */
const INITIAL_EXTENSIONS = [
  { id: 'lumiverse_suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true },
  { id: 'ext_owner', identifier: 'ext_owner', enabled: true, has_frontend: true },
]

function suiteHalfAction(runtimeSuffix: number, onClick?: () => void): InputBarActionState {
  return {
    id: `lumiverse_suite:action:${HALF_CONTRIBUTION}:${runtimeSuffix}`,
    contributionId: HALF_CONTRIBUTION,
    extensionId: 'lumiverse_suite',
    extensionName: 'Lumiverse Suite',
    placement: 'world_book.entry_toolbar',
    label: 'Half-Screen Lorebook Editor',
    enabled: true,
    clickHandlers: new Set(onClick ? [onClick] : []),
  }
}

function extensionDrawerTab(contributionId: string, runtimeSuffix: number): DrawerTabState {
  return {
    id: `spindle:ext_owner:tab:${contributionId}:${runtimeSuffix}`,
    extensionId: 'ext_owner',
    contributionId,
    title: `Page ${contributionId}`,
    badge: null,
    root: document.createElement('div'),
  }
}

const state = {
  quickToolbarSettings: {
    enabled: true,
    visibleTabIds: ['settings', 'command:action-home'],
    iconOrder: ['settings', 'command:action-home'],
    variant: 'v2-settings-adjacent',
  },
  user: null,
  drawerTabs: [] as DrawerTabState[],
  extensionCommands: [],
  /** Both owners that supply the live registrations this file exercises. */
  extensions: INITIAL_EXTENSIONS,
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
  adaptExtensionTabs: (tabs: DrawerTabState[]) => tabs.map((tab) => ({
    id: tab.id,
    tabName: tab.title,
    tabDescription: `Open ${tab.title} extension tab`,
    tabIcon: () => null,
    keywords: ['extension', 'spindle', tab.extensionId],
  })),
  extensionCommandsToCommands: () => [],
}))
mock.module('@/lib/settings-tab-registry', () => ({ getVisibleSettingsTabs: () => [] }))
mock.module('@/lib/quickToolbarToggle', () => ({
  resolveToolbarIntent: () => ({ type: 'run-command' }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  // Real filtered-move semantics, inlined so the mock cannot recurse through the
  // module it replaces (an imported binding here would be the mock itself).
  moveWithinFiltered: (orderedIds: string[], filteredIds: string[], id: string, direction: -1 | 1): string[] => {
    const from = orderedIds.indexOf(id)
    if (from < 0) return orderedIds
    const visible = new Set(filteredIds)
    if (!visible.has(id)) return orderedIds
    const visibleIndices: number[] = []
    for (let index = 0; index < orderedIds.length; index += 1) {
      if (visible.has(orderedIds[index])) visibleIndices.push(index)
    }
    const cursor = visibleIndices.indexOf(from)
    if (cursor < 0) return orderedIds
    const neighbour = cursor + direction
    if (neighbour < 0 || neighbour >= visibleIndices.length) return orderedIds
    const next = [...orderedIds]
    const [moved] = next.splice(from, 1)
    next.splice(visibleIndices[neighbour], 0, moved)
    return next
  },
}))
mock.module('@/lib/uiProductivityDefaults', () => ({
  DEFAULT_QUICK_TOOLBAR_SETTINGS: state.quickToolbarSettings,
}))

let createRoot: typeof CreateRoot
let useQuickToolbarActions: typeof import('./useQuickToolbarActions').useQuickToolbarActions
let isQuickToolbarInputAction: typeof import('./useQuickToolbarActions').isQuickToolbarInputAction
let quickToolbarInputActionId: typeof import('./useQuickToolbarActions').quickToolbarInputActionId
let quickToolbarInputActionIcon: typeof import('./useQuickToolbarActions').quickToolbarInputActionIcon
let quickToolbarInputActionLabel: typeof import('./useQuickToolbarActions').quickToolbarInputActionLabel

/** Attribute keys contain JSON quotes, which are not selector-safe. */
function hasActionId(host: HTMLElement, id: string): boolean {
  return [...host.querySelectorAll('[data-action-id]')].some((node) => node.getAttribute('data-action-id') === id)
}

function Probe() {
  const {
    actions,
    actionCatalog,
    actionById,
    visibleIds,
    orderedIds,
    toggleAction,
    moveAction,
    moveActionWithin,
    reorderActions,
    reorderActionPair,
    pinAction,
  } = useQuickToolbarActions()
  const drawerSurfaces = actionCatalog.flatMap((action) => (
    action.surface.kind === 'drawer' ? [`${action.id}=>${action.surface.tabId}`] : []
  ))
  return <>
    <output data-testid="toolbar-action-count">{actions.length}</output>
    <output data-testid="visible-ids">{visibleIds.join('|')}</output>
    <output data-testid="ordered-ids">{orderedIds.join('|')}</output>
    <output data-testid="catalog-has-half">{actionById.has(HALF_CONTRIBUTION) ? 'yes' : 'no'}</output>
    <output data-testid="drawer-surfaces">{drawerSurfaces.join('|')}</output>
    {actions.map((action) => {
      const Icon = action.icon
      return <output key={action.id} data-action-id={action.id}><Icon size={16} /><span>{action.label}</span></output>
    })}
    <button data-testid="toggle-home" type="button" onClick={() => toggleAction('command:action-home')}>toggle home</button>
    <button data-testid="toggle-half" type="button" onClick={() => toggleAction(HALF_CONTRIBUTION)}>toggle half</button>
    <button data-testid="run-half" type="button" onClick={() => actions.find((action) => action.id === HALF_CONTRIBUTION)?.run()}>run half</button>
    <button data-testid="run-connections" type="button" onClick={() => actions.find((action) => action.id === 'lumiverse_suite.connections_picker.open')?.run()}>run connections</button>
    <button data-testid="run-by-key" type="button" onClick={() => actions[0]?.run()}>run first</button>
    <button data-testid="move-settings-up" type="button" onClick={() => moveAction('settings', -1)}>move settings up</button>
    <button data-testid="pin-settings" type="button" onClick={() => pinAction('settings')}>pin settings</button>
    <button data-testid="pin-first" type="button" onClick={() => { const first = orderedIds[0]; if (first) pinAction(first) }}>pin first</button>
    <button data-testid="reorder-reverse" type="button" onClick={() => reorderActions([...orderedIds].reverse())}>reverse</button>
    <button data-testid="reorder-stale" type="button" onClick={() => reorderActions(['command:action-home', 'ghost:absent'])}>stale</button>
    <button data-testid="reorder-pair" type="button" onClick={() => reorderActionPair('settings', 'command:action-home')}>pair</button>
    <button
      data-testid="reorder-captured-swap"
      type="button"
      onClick={() => reorderActions([orderedIds[1], orderedIds[0]].filter((id): id is string => typeof id === 'string'))}
    >
      captured swap
    </button>
    <button data-testid="pin-captured" type="button" onClick={() => { const target = orderedIds[0]; if (target) pinAction(target) }}>pin captured</button>
    <button data-testid="filter-move-settings-up" type="button" onClick={() => moveActionWithin('settings', -1, orderedIds)}>filter move</button>
    <button data-testid="subset-move-b" type="button" onClick={() => moveActionWithin(SUBSET_TARGET, -1, [SUBSET_FIRST, SUBSET_TARGET])}>subset move</button>
    <button data-testid="stale-subset-move" type="button" onClick={() => moveActionWithin('settings', -1, ['settings', 'ghost:absent'])}>stale subset move</button>
    <button
      data-testid="two-edits"
      type="button"
      onClick={() => {
        toggleAction('settings')
        toggleAction(HALF_CONTRIBUTION)
      }}
    >
      two edits
    </button>
  </>
}

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useQuickToolbarActions, isQuickToolbarInputAction, quickToolbarInputActionId, quickToolbarInputActionIcon, quickToolbarInputActionLabel } = await import('./useQuickToolbarActions'))
})

afterEach(() => {
  document.body.replaceChildren()
  settingWrites.length = 0
  state.drawerTabs = []
  state.inputBarActions = []
  state.extensions = INITIAL_EXTENSIONS
  state.quickToolbarSettings = {
    enabled: true,
    visibleTabIds: ['settings', 'command:action-home'],
    iconOrder: ['settings', 'command:action-home'],
    variant: 'v2-settings-adjacent',
  }
})

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
    expect(quickToolbarInputActionLabel({ ...half, label: 'Open half editor' })).toBe('Half-Screen Lorebook Editor')
    expect(quickToolbarInputActionLabel({ ...enhanced, label: 'Open enhanced workspace' })).toBe('Full-Screen Lorebook Editor')
    // Another owner reusing the same contribution name gets the namespaced tuple key.
    expect(quickToolbarInputActionId({ id: 'ext:action:widget:1', contributionId: 'widget', extensionId: 'other_owner' }))
      .toBe('ext-action:["input","other_owner","widget"]')
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

    await act(async () => root.unmount())
  })

  test('keys a re-registered extension action by its logical tuple, not the counter', async () => {
    let firstOpens = 0
    let reloadedOpens = 0
    state.inputBarActions = [suiteHalfAction(1, () => { firstOpens += 1 })]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION],
      iconOrder: [HALF_CONTRIBUTION],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(true)

    // Extension reload: new runtime handle, same logical tuple.
    state.inputBarActions = [suiteHalfAction(9, () => { reloadedOpens += 1 })]
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="run-half"]')?.click()
      await Promise.resolve()
    })
    expect(reloadedOpens).toBe(1)
    expect(firstOpens).toBe(0)

    await act(async () => root.unmount())
  })

  test('withholds a duplicate logical tuple until exactly one registration remains', async () => {
    state.inputBarActions = [suiteHalfAction(1), suiteHalfAction(2)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(false)
    expect(host.querySelector('[data-testid="catalog-has-half"]')?.textContent).toBe('no')

    // One registration destroyed: the survivor is restored against its handle.
    let opens = 0
    state.inputBarActions = [suiteHalfAction(2, () => { opens += 1 })]
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="run-half"]')?.click()
      await Promise.resolve()
    })
    expect(opens).toBe(1)

    await act(async () => root.unmount())
  })

  test('preserves a withheld tuple string and writes no preferences from a render', async () => {
    state.inputBarActions = [suiteHalfAction(1), suiteHalfAction(2)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    // Normalization is a read projection: no hydration or render write.
    expect(settingWrites).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-half"]')?.click()
      await Promise.resolve()
    })
    const written = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    expect(written.visibleTabIds).toEqual(['settings'])
    expect(written.iconOrder).toEqual([HALF_CONTRIBUTION, 'settings'])

    await act(async () => root.unmount())
  })

  test('preserves absent and hidden complementary slots through pin, move and drag', async () => {
    const absentHiddenOrder = ['command:action-home', 'ghost:absent', 'settings', 'profile']
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: [...absentHiddenOrder],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pin-settings"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: ['settings', 'ghost:absent', 'command:action-home', 'profile'],
    })

    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: [...absentHiddenOrder],
    }
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="move-settings-up"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: ['settings', 'ghost:absent', 'command:action-home', 'profile'],
    })

    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: [...absentHiddenOrder],
    }
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-reverse"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: ['settings', 'ghost:absent', 'command:action-home', 'profile'],
    })

    await act(async () => root.unmount())
  })

  test('excludes a uniquely ineligible extension tuple from rendering and reordering', async () => {
    // One registration, unique tuple, but on a placement the toolbar does not
    // serve. It is in the logical catalog for normalization only and must not
    // become selectable even though the stored preference still names its key.
    const ineligibleOnly: InputBarActionState = {
      ...suiteHalfAction(1),
      id: 'ext_owner:action:widget-ish:1',
      contributionId: 'widget-ish',
      extensionId: 'ext_owner',
      extensionName: 'Ext Owner',
      placement: 'world_book.entry_toolbar',
    }
    state.inputBarActions = [ineligibleOnly]
    const ineligibleKey = 'ext-action:["input","ext_owner","widget-ish"]'
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [ineligibleKey, 'settings'],
      iconOrder: [ineligibleKey, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(isQuickToolbarInputAction(ineligibleOnly)).toBe(false)
    expect(hasActionId(host, ineligibleKey)).toBe(false)
    // The reorderable snapshot holds only genuinely selectable ids, so a drag is
    // still usable even though the stored order names an unrenderable key.
    expect(host.querySelector('[data-testid="visible-ids"]')?.textContent).toBe('settings')
    expect(settingWrites).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-home"]')?.click()
      await Promise.resolve()
    })
    const written = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    // A genuine edit must not drop the unresolvable preference string or its slot.
    expect(written.visibleTabIds).toContain(ineligibleKey)
    expect(written.iconOrder).toContain(ineligibleKey)
    expect(written.iconOrder).toContain('ghost:absent')

    await act(async () => root.unmount())
  })

  test('withholds a tuple registered once eligible and once on another placement', async () => {
    // Same logical tuple, two runtime handles, only one of them eligible for the
    // toolbar: duplicate grouping runs over ALL registrations, so neither handle
    // may be selected as the callback.
    const ELIGIBLE_PLACEMENT = 'input_bar.extras'
    const ineligibleContribution = 'other_action'
    const eligible: InputBarActionState = {
      ...suiteHalfAction(1),
      id: 'ext_owner:action:widget-ish:1',
      contributionId: 'widget-ish',
      extensionId: 'ext_owner',
      extensionName: 'Ext Owner',
      placement: ELIGIBLE_PLACEMENT,
    }
    const ineligible: InputBarActionState = {
      ...eligible,
      id: 'ext_owner:action:widget-ish:2',
      placement: 'world_book.entry_toolbar',
    }
    state.inputBarActions = [eligible, ineligible]
    const sharedKey = 'ext-action:["input","ext_owner","widget-ish"]'
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [sharedKey, 'settings'],
      iconOrder: [sharedKey, 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(isQuickToolbarInputAction(eligible)).toBe(true)
    expect(isQuickToolbarInputAction(ineligible)).toBe(false)
    expect(hasActionId(host, sharedKey)).toBe(false)
    expect(host.querySelector('[data-testid="visible-ids"]')?.textContent).toBe('settings')
    // Normalization is read-only, so the persisted strings are still untouched.
    expect(settingWrites).toEqual([])

    // Dropping the ineligible registration leaves one unique eligible handle.
    let opens = 0
    state.inputBarActions = [{ ...eligible, clickHandlers: new Set([() => { opens += 1 }]) }]
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, sharedKey)).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="run-by-key"]')?.click()
      await Promise.resolve()
    })
    expect(opens).toBe(1)

    await act(async () => root.unmount())
  })

  test('no-ops a captured reorder after a bare Suite action unregisters without a rerender', async () => {
    // The bare Suite key is not an ext-action:/ext-runtime: string, so extension
    // availability must recognise it explicitly; otherwise the stale rendered
    // catalog re-admits it and a captured snapshot reorders an unavailable slot.
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    // The rendered snapshot the user is dragging against.
    expect(host.querySelector('[data-testid="ordered-ids"]')?.textContent).toBe(`${HALF_CONTRIBUTION}|settings`)

    // The Suite action is destroyed with NO rerender, so `orderedIds` still holds it.
    state.inputBarActions = []
    settingWrites.length = 0

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-captured-swap"]')?.click()
      await Promise.resolve()
    })
    // The write path re-read fresh availability, so the captured permutation is stale.
    expect(settingWrites).toEqual([])

    // The withheld slot and the original stored strings are untouched by the write path.
    expect(state.quickToolbarSettings.visibleTabIds).toEqual([HALF_CONTRIBUTION, 'settings'])
    expect(state.quickToolbarSettings.iconOrder).toEqual([HALF_CONTRIBUTION, 'ghost:absent', 'settings'])

    await act(async () => root.unmount())
  })

  test('no-ops a captured pin of an unregistered bare Suite action without a rerender', async () => {
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    state.inputBarActions = []
    settingWrites.length = 0

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pin-captured"]')?.click()
      await Promise.resolve()
    })
    // An unavailable target is a no-op through the shared pin operation.
    expect(settingWrites).toEqual([])
    expect(state.quickToolbarSettings.iconOrder).toEqual([HALF_CONTRIBUTION, 'ghost:absent', 'settings'])

    await act(async () => root.unmount())
  })

  test('no-ops a captured reorder and pin while a bare Suite action is duplicate-withheld', async () => {
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(true)
    state.inputBarActions = [suiteHalfAction(1), suiteHalfAction(2)]
    expect(settingWrites).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-captured-swap"]')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pin-captured"]')?.click()
      await Promise.resolve()
    })
    // Neither the withheld bare key nor the absent decoy slot may be touched, and
    // the stored strings stay exactly as they were.
    expect(settingWrites).toEqual([])
    expect(state.quickToolbarSettings.visibleTabIds).toEqual([HALF_CONTRIBUTION, 'settings'])
    expect(state.quickToolbarSettings.iconOrder).toEqual([HALF_CONTRIBUTION, 'ghost:absent', 'settings'])

    await act(async () => root.unmount())
  })

  test('keeps an unresolved stable key when its registration is temporarily gone', async () => {
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    // The owner unregisters: the stable key must neither render nor be dropped.
    state.inputBarActions = []
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="visible-ids"]')?.textContent).toBe('settings')
    expect(host.querySelector('[data-testid="ordered-ids"]')?.textContent).toBe('settings')
    expect(settingWrites).toEqual([])

    // A later edit over the remaining visible set must still keep the unresolved
    // key in storage rather than dropping it from the persisted arrays.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-home"]')?.click()
      await Promise.resolve()
    })
    const written = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    expect(written.visibleTabIds).toContain(HALF_CONTRIBUTION)
    expect(written.iconOrder).toContain(HALF_CONTRIBUTION)
    expect(written.visibleTabIds).toContain('settings')

    await act(async () => root.unmount())
  })

  test('moves within a genuine search-filter subset and keeps every other slot', async () => {
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [SUBSET_FIRST, SUBSET_TARGET, SUBSET_LAST],
      iconOrder: [SUBSET_FIRST, 'ghost:absent', SUBSET_TARGET, 'settings', SUBSET_LAST, 'profile'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    // Filter is [chat.new, chat.manage] - a strict subset of the available set
    // [chat.new, chat.manage, chat.prompt-variables]; the target gets one visible
    // step up and the absent/hidden decoy slots keep their positions.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="subset-move-b"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: [SUBSET_FIRST, SUBSET_TARGET, SUBSET_LAST],
      iconOrder: [SUBSET_TARGET, 'ghost:absent', SUBSET_FIRST, 'settings', SUBSET_LAST, 'profile'],
    })

    await act(async () => root.unmount())
  })

  test('treats a filtered snapshot referencing a gone id as a no-op', async () => {
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['settings'],
      iconOrder: ['settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    settingWrites.length = 0

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="stale-subset-move"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites).toEqual([])

    await act(async () => root.unmount())
  })

  test('rejects a stale drag and keeps ids added after the snapshot', async () => {
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['command:action-home', 'settings'],
      iconOrder: ['command:action-home', 'ghost:absent', 'settings', 'profile'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    // A snapshot whose membership no longer matches the reorderable set is stale.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-stale"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-half"]')?.click()
      await Promise.resolve()
    })
    const afterShow = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    expect(afterShow.visibleTabIds).toContain(HALF_CONTRIBUTION)
    expect(afterShow.iconOrder).toContain(HALF_CONTRIBUTION)

    // Re-render the way the store subscription does before the next user event.
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    settingWrites.length = 0
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-reverse"]')?.click()
      await Promise.resolve()
    })
    const afterDrag = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    // The id added after the earlier snapshot survives the drag.
    expect(afterDrag.iconOrder).toContain(HALF_CONTRIBUTION)
    expect(afterDrag.iconOrder).toContain('ghost:absent')
    expect(afterDrag.iconOrder).toContain('profile')

    await act(async () => root.unmount())
  })

  test('commits two edits made before a rerender', async () => {
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: ['settings', 'command:action-home'],
      iconOrder: ['settings', 'command:action-home'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="two-edits"]')?.click()
      await Promise.resolve()
    })

    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: ['command:action-home', HALF_CONTRIBUTION],
      iconOrder: ['settings', 'command:action-home', HALF_CONTRIBUTION],
    })

    await act(async () => root.unmount())
  })

  test('reads a legacy drawer counter key as its stable key and keeps the runtime surface', async () => {
    const tab = extensionDrawerTab('settings-page', 7)
    const legacyKey = 'spindle:ext_owner:tab:settings-page:7'
    const stableKey = 'ext-action:["drawer","ext_owner","settings-page"]'
    state.drawerTabs = [tab]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [legacyKey],
      iconOrder: [legacyKey],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(hasActionId(host, stableKey)).toBe(true)
    expect(host.querySelector('[data-testid="visible-ids"]')?.textContent).toBe(stableKey)
    // The persisted id is stable; the surface still targets the runtime handle.
    expect(host.querySelector('[data-testid="drawer-surfaces"]')?.textContent).toBe(`${stableKey}=>${tab.id}`)

    settingWrites.length = 0
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pin-first"]')?.click()
      await Promise.resolve()
    })
    expect(settingWrites.at(-1)?.value).toMatchObject({
      visibleTabIds: [stableKey],
      iconOrder: [stableKey],
    })

    await act(async () => root.unmount())
  })

  test('no-ops captured pin and reorder handlers once the owner is disabled without a rerender', async () => {
    // The rendered catalog was built while the owner was enabled; the write path
    // must re-read the LATEST owner state instead of trusting that snapshot, or a
    // captured handler would drag an action the owner has already withdrawn.
    state.inputBarActions = [suiteHalfAction(1)]
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [HALF_CONTRIBUTION, 'settings'],
      iconOrder: [HALF_CONTRIBUTION, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    // The snapshot the user is acting against: the owner's action is live.
    expect(hasActionId(host, HALF_CONTRIBUTION)).toBe(true)
    expect(host.querySelector('[data-testid="ordered-ids"]')?.textContent).toBe(`${HALF_CONTRIBUTION}|settings`)

    // Owner disabled with NO rerender, so the captured handlers still see the
    // rendered catalog that holds the now-unavailable action.
    state.extensions = [
      { id: 'lumiverse_suite', identifier: 'lumiverse_suite', enabled: false, has_frontend: true },
      INITIAL_EXTENSIONS[1],
    ]
    settingWrites.length = 0

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pin-captured"]')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="reorder-captured-swap"]')?.click()
      await Promise.resolve()
    })

    // Both captured writes no-op: the persisted arrays and the absent decoy slot
    // are untouched, and the unavailable logical slot is retained on disk.
    expect(settingWrites).toEqual([])
    expect(state.quickToolbarSettings.visibleTabIds).toEqual([HALF_CONTRIBUTION, 'settings'])
    expect(state.quickToolbarSettings.iconOrder).toEqual([HALF_CONTRIBUTION, 'ghost:absent', 'settings'])

    await act(async () => root.unmount())
  })

  test('withholds a disabled owner registration without hiding the enabled owner duplicate', async () => {
    // The raw logical catalog keeps BOTH registrations regardless of owner state,
    // so the legacy ambiguity is resolved the same way the enabled case resolves
    // it; only the eligible maps are owner-filtered. Here one owner is disabled
    // and the other is enabled, and the two registrations share a logical tuple.
    state.extensions = [
      { id: 'lumiverse_suite', identifier: 'lumiverse_suite', enabled: false, has_frontend: true },
      INITIAL_EXTENSIONS[1],
    ]
    state.inputBarActions = [
      suiteHalfAction(7),
      {
        ...suiteHalfAction(1),
        id: 'ext_owner:action:widget-ish:1',
        contributionId: 'widget-ish',
        extensionId: 'ext_owner',
        extensionName: 'Ext Owner',
        label: 'Ext Owner action',
      },
    ]
    const disabledSuiteKey = HALF_CONTRIBUTION
    state.quickToolbarSettings = {
      ...state.quickToolbarSettings,
      visibleTabIds: [disabledSuiteKey, 'settings'],
      iconOrder: [disabledSuiteKey, 'ghost:absent', 'settings'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    // The disabled owner's key renders nothing, but its stored string survives.
    expect(hasActionId(host, disabledSuiteKey)).toBe(false)
    expect(settingWrites).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-home"]')?.click()
      await Promise.resolve()
    })
    const written = settingWrites.at(-1)?.value as { visibleTabIds: string[]; iconOrder: string[] }
    expect(written.visibleTabIds).toContain(disabledSuiteKey)
    expect(written.iconOrder).toContain(disabledSuiteKey)
    expect(written.iconOrder).toContain('ghost:absent')

    await act(async () => root.unmount())
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
