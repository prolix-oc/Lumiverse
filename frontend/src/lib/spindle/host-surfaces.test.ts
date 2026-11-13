import { describe, expect, mock, test } from 'bun:test'
import type { ExtensionCommandState, InputBarActionState } from '@/store/slices/spindle-placement'

const COMMANDS = [
  ['action-new-chat', 'global'],
  ['action-delete-last-message', 'chat'],
  ['action-regenerate', 'chat-idle'],
  ['action-background-swipe', 'chat-idle'],
  ['action-stop-generation', 'chat'],
  ['action-swipe-left', 'chat'],
  ['action-swipe-right', 'chat'],
].map(([id, scope]) => ({
  id,
  label: id,
  description: id,
  icon: () => null,
  keywords: id.split('-'),
    group: 'actions' as const,
    scope: scope as 'global' | 'chat' | 'chat-idle',
  run: () => {},
}))

const testStore = {
  user: null,
  drawerTabs: [],
  extensionCommands: [],
  inputBarActions: [],
  pendingWorldBookEditEntryId: null as string | null,
  settingsCalls: [] as unknown[][],
  openSettings(...args: unknown[]) {
    testStore.settingsCalls.push(args)
  },
  personas: [{ id: 'persona-1', name: 'Ann' }],
  savedThemes: [{ id: 'saved-1', name: 'Night Owl', kind: 'config' }],
  appliedSavedThemes: [] as string[],
  applySavedTheme(id: string) {
    testStore.appliedSavedThemes.push(id)
  },
  activeModal: null as string | null,
  modalProps: {} as Record<string, unknown>,
  setPendingWorldBookEditEntryId(id: string | null) {
    testStore.pendingWorldBookEditEntryId = id
  },
  openModal(id: string, props: Record<string, unknown>) {
    testStore.activeModal = id
    testStore.modalProps = props
  },
}

mock.module('@/lib/commands', () => ({ COMMANDS }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: [],
  extensionTabsToCommands: () => [],
}))
let visibleSettingsTabs: unknown[] = []
mock.module('@/lib/settings-tab-registry', () => ({
  getVisibleSettingsTabs: () => visibleSettingsTabs,
  settingsRegistryToCommands: () => [],
}))
mock.module('@/lib/app-navigation', () => ({ navigateApp: () => {} }))
mock.module('@/store', () => ({
  useStore: Object.assign(() => testStore, {
    getState: () => testStore,
    subscribe: () => () => {},
  }),
}))
mock.module('@/ws/client', () => ({ wsClient: { send: () => {} } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
let personaSelection: void | Promise<void>
mock.module('@/lib/personaSelection', () => ({ selectPersona: () => personaSelection }))

const { buildHostSurfaceCatalog, createHostSurfaceAPI } = await import('./host-surfaces')
const { configurePresetSelectionCoordinator } = await import('@/lib/loom/preset-selection-coordinator')

const drawer = (id: string) => ({ id, tabName: id, tabDescription: `${id} panel`, shortName: id, keywords: [id] }) as any
const settings = (id: string, role?: 'admin' | 'owner') => ({ id, tabName: id, tabDescription: `${id} settings`, shortName: id, keywords: [id], role }) as any

function input(id: string, extensionId: string, externallyInvocable = true): InputBarActionState {
  return {
    id,
    extensionId,
    extensionName: extensionId,
    label: id,
    enabled: true,
    externallyInvocable,
    clickHandlers: new Set(),
  }
}

describe('H4 host surface catalog and invocation', () => {
  test('retired Council drawer IDs stay invocable without appearing in the catalog', () => {
    const calls: string[] = []
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a', getGrantedPermissions: () => [],
      getInputs: () => ({ drawerTabs: [drawer('council')], commands: [] }),
      runtime: { openDrawer: (id) => { calls.push(id) } },
    })
    for (const id of ['ooc', 'feedback']) api.invoke({ kind: 'drawer_tab', id })
    expect(calls).toEqual(['ooc', 'feedback'])
    expect(api.list().filter((surface) => surface.kind === 'drawer_tab').map((surface) => surface.id)).toEqual(['council'])
    expect(() => api.invoke({ kind: 'drawer_tab', id: 'unknown-drawer' })).toThrow('HOST_ACTION_UNAVAILABLE')
    expect(() => api.invoke({ kind: 'drawer_tab', id: 'toString' })).toThrow('HOST_ACTION_UNAVAILABLE')
    const unavailable = createHostSurfaceAPI({
      extensionId: 'ext-a', getGrantedPermissions: () => [],
      getInputs: () => ({ drawerTabs: [], commands: [] }),
    })
    expect(() => unavailable.invoke({ kind: 'drawer_tab', id: 'ooc' })).toThrow('HOST_ACTION_UNAVAILABLE')
  })
  test('catalog assembly is deduplicated and keeps route/modal allowlists', () => {
    const catalog = buildHostSurfaceCatalog({
      drawerTabs: [drawer('profile'), drawer('profile')],
      settingsTabs: [settings('voice')],
      commands: [COMMANDS.find((command) => command.id === 'action-new-chat')!],
    })
    expect(catalog.filter((surface) => surface.kind === 'drawer_tab' && surface.id === 'profile')).toHaveLength(1)
    expect(catalog.filter((surface) => surface.kind === 'route').map((surface) => surface.id)).toEqual([
      '/', '/chat/:chatId', '/characters', '/characters/:id',
    ])
    expect(catalog.filter((surface) => surface.kind === 'modal').map((surface) => surface.id)).toEqual(['character_editor', 'world_book_editor'])
  })

  test('authority is checked per action id and unknown command ids fail closed', () => {
    const calls: string[] = []
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => ['generation'],
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] }),
      runtime: {
        runCommand: (id) => { calls.push(id) },
      },
    })
    expect(() => api.invoke({ kind: 'command', id: 'action-delete-last-message' })).toThrow('PERMISSION_DENIED:chats')
    expect(() => api.invoke({ kind: 'command', id: 'not-in-the-map' })).toThrow('HOST_ACTION_UNMAPPED')
    api.invoke({ kind: 'command', id: 'action-regenerate' })
    expect(calls).toEqual(['action-regenerate'])
  })

  test.each([
    ['action-stop-generation', 'generation'],
    ['action-background-swipe', 'generation'],
    ['action-swipe-left', 'chats'],
    ['action-swipe-right', 'generation'],
  ])('%s checks its permission on every invocation', (id, permission) => {
    const calls: string[] = []
    let granted: string[] = []
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => granted,
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] }),
      runtime: { runCommand: (commandId) => { calls.push(commandId) } },
    })
    expect(api.list(['command']).some((surface) => surface.id === id)).toBe(true)
    expect(() => api.invoke({ kind: 'command', id })).toThrow(`PERMISSION_DENIED:${permission}`)
    expect(calls).toEqual([])
    granted = [permission]
    api.invoke({ kind: 'command', id })
    expect(calls).toEqual([id])
    granted = []
    expect(() => api.invoke({ kind: 'command', id })).toThrow(`PERMISSION_DENIED:${permission}`)
    expect(calls).toEqual([id])
  })

  test('world-book editor invocation requires permission and forwards the entry target', () => {
    const calls: Array<[string, string | undefined]> = []
    const denied = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => [],
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] }),
    })
    expect(() => denied.invoke(
      { kind: 'modal', id: 'world_book_editor' },
      { id: 'book-1', entryId: 'entry-1' },
    )).toThrow('PERMISSION_DENIED:world_books')

    const allowed = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => ['world_books'],
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] }),
      runtime: {
        openWorldBookEditor: (id, entryId) => { calls.push([id, entryId]) },
      },
    })
    allowed.invoke(
      { kind: 'modal', id: 'world_book_editor' },
      { id: 'book-1', entryId: 'entry-1' },
    )
    expect(calls).toEqual([['book-1', 'entry-1']])
  })

  test('default world-book action opens the native editor at the requested book and entry', () => {
    testStore.pendingWorldBookEditEntryId = 'stale-entry'
    testStore.activeModal = null
    testStore.modalProps = {}
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => ['world_books'],
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] }),
    })

    api.invoke(
      { kind: 'modal', id: 'world_book_editor' },
      { id: 'book-1', entryId: 'entry-1' },
    )

    expect(testStore.activeModal).toBe('worldBookEditor')
    expect(testStore.modalProps).toEqual({ bookId: 'book-1' })
    expect(testStore.pendingWorldBookEditEntryId).toBe('entry-1')
  })

  test('self input actions are free, cross-extension actions require app_manipulation, and opt-out is honored', async () => {
    const calls: string[] = []
    const actions = [input('a-action', 'ext-a'), input('b-action', 'ext-b', false)]
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => [],
      getInputs: () => ({ userRole: 'user', inputBarActions: actions, extensionCommands: [] }),
      runtime: { invokeInputBarAction: (id) => { calls.push(id) } },
    })
    await api.invoke({ kind: 'input_bar_action', id: 'a-action' })
    expect(calls).toEqual(['a-action'])
    expect(() => api.invoke({ kind: 'input_bar_action', id: 'b-action' })).toThrow('HOST_ACTION_NOT_EXTERNALLY_INVOCABLE')

    const crossApi = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => ['app_manipulation'],
      getInputs: () => ({ userRole: 'user', inputBarActions: [input('b-action', 'ext-b')], extensionCommands: [] }),
      runtime: { invokeInputBarAction: (id) => { calls.push(id) } },
    })
    await crossApi.invoke({ kind: 'input_bar_action', id: 'b-action' })
    expect(calls).toEqual(['a-action', 'b-action'])
  })

  test('the live catalog lists the core settings tabs, not extension tab bodies', () => {
    visibleSettingsTabs = [settings('account'), settings('voice')]
    Object.assign(testStore, { settingsTabs: [{ tabId: 'voice', extensionId: 'ext-b' }] })
    try {
      const api = createHostSurfaceAPI({ extensionId: 'ext-a' })
      expect(api.list(['settings_tab']).map((surface) => surface.id)).toEqual(['account', 'voice'])
    } finally {
      visibleSettingsTabs = []
    }
  })

  test('default settings action forwards the section anchor', () => {
    testStore.settingsCalls = []
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getInputs: () => ({ userRole: 'user', settingsTabs: [settings('voice')], inputBarActions: [], extensionCommands: [] }),
    })
    api.invoke({ kind: 'settings_tab', id: 'voice' }, { anchorId: 'setsec-voice-tts' })
    api.invoke({ kind: 'settings_tab', id: 'voice' })
    expect(testStore.settingsCalls).toEqual([['voice', { anchorId: 'setsec-voice-tts' }], ['voice', undefined]])
  })

  test('entity actions are listed with a param schema and theme choices', () => {
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getInputs: () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [], themes: [{ id: 'rose', name: 'Rose' }, { id: 'saved-1', name: 'Night Owl' }] }),
    })
    const actions = api.list(['entity_action'])
    expect(actions.map((surface) => surface.id)).toEqual(['switch_persona', 'switch_preset', 'apply_theme', 'character_chat'])
    expect(actions.find((surface) => surface.id === 'character_chat')?.params).toMatchObject({
      type: 'object',
      required: ['characterId', 'mode'],
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['latest', 'new'] } },
    })
    expect(actions.find((surface) => surface.id === 'apply_theme')?.params?.properties.themeId.oneOf).toEqual([
      { const: 'rose', title: 'Rose' },
      { const: 'saved-1', title: 'Night Owl' },
    ])
  })

  test('entity actions check their permission and that the entity exists', () => {
    const calls: string[] = []
    const inputs = () => ({ userRole: 'user', inputBarActions: [], extensionCommands: [] })
    const denied = createHostSurfaceAPI({ extensionId: 'ext-a', getGrantedPermissions: () => ['chats'], getInputs: inputs })
    expect(() => denied.invoke({ kind: 'entity_action', id: 'switch_persona' }, { personaId: 'persona-1' })).toThrow('PERMISSION_DENIED:personas')
    expect(() => denied.invoke({ kind: 'entity_action', id: 'apply_theme' }, { themeId: 'rose' })).toThrow('PERMISSION_DENIED:app_manipulation')

    const allowed = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getGrantedPermissions: () => ['personas', 'app_manipulation'],
      getInputs: inputs,
      runtime: { switchPersona: (id) => { calls.push(id) } },
    })
    allowed.invoke({ kind: 'entity_action', id: 'switch_persona' }, { personaId: 'persona-1' })
    expect(calls).toEqual(['persona-1'])
    testStore.appliedSavedThemes = []
    allowed.invoke({ kind: 'entity_action', id: 'apply_theme' }, { themeId: 'saved-1' })
    expect(testStore.appliedSavedThemes).toEqual(['saved-1'])
    expect(() => allowed.invoke({ kind: 'entity_action', id: 'apply_theme' }, { themeId: 'missing' })).toThrow('HOST_ACTION_NOT_FOUND:themeId')

    const defaults = createHostSurfaceAPI({ extensionId: 'ext-a', getGrantedPermissions: () => ['personas'], getInputs: inputs })
    expect(() => defaults.invoke({ kind: 'entity_action', id: 'switch_persona' }, { personaId: 'persona-2' })).toThrow('HOST_ACTION_NOT_FOUND:personaId')
  })

  test('the default persona runtime forwards persistence failures to its caller', async () => {
    let fail!: (error: Error) => void
    personaSelection = new Promise<void>((_, reject) => { fail = reject })
    const api = createHostSurfaceAPI({ extensionId: 'ext-a', getGrantedPermissions: () => ['personas'], getInputs: () => ({}) })
    const pending = api.invoke({ kind: 'entity_action', id: 'switch_persona' }, { personaId: 'persona-1' })
    expect(pending).toBe(personaSelection)
    fail(new Error('persona persistence failed'))
    await expect(pending).rejects.toThrow('persona persistence failed')
    personaSelection = undefined
  })

  test('a superseded preset action rejects while the latest action flushes and switches', async () => {
    let activePresetId = 'previous'
    const calls: string[] = []
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (id) => { activePresetId = id!; calls.push(`select:${id}`) },
      flushPreset: async (id) => { calls.push(`flush:${id}`) },
    })
    const api = createHostSurfaceAPI({ extensionId: 'ext-a', getGrantedPermissions: () => ['presets'], getInputs: () => ({}) })
    const previous = api.invoke({ kind: 'entity_action', id: 'switch_preset' }, { presetId: 'superseded' })
    const latest = api.invoke({ kind: 'entity_action', id: 'switch_preset' }, { presetId: 'latest' })
    await expect(previous).rejects.toThrow('HOST_ACTION_UNAVAILABLE:entity_action:switch_preset')
    await latest
    expect(calls).toEqual(['flush:previous', 'select:latest'])
    expect(activePresetId).toBe('latest')
  })

  test.each([
    ['switch_persona', 'personas', { personaId: 'persona-1' }],
    ['switch_preset', 'presets', { presetId: 'preset-1' }],
    ['apply_theme', 'app_manipulation', { themeId: 'rose' }],
    ['character_chat', 'chats', { characterId: 'char-1', mode: 'new' }],
  ] as const)('%s checks current grants before calling any runtime', (id, permission, params) => {
    let granted: string[] = []
    const calls: string[] = []
    const invoke = () => { calls.push(id) }
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a', getGrantedPermissions: () => granted, getInputs: () => ({}),
      runtime: { switchPersona: invoke, switchPreset: invoke, applyTheme: invoke, openCharacterChat: invoke },
    })
    expect(() => api.invoke({ kind: 'entity_action', id }, params)).toThrow(`PERMISSION_DENIED:${permission}`)
    expect(calls).toEqual([])
    granted = [permission]
    api.invoke({ kind: 'entity_action', id }, params)
    expect(calls).toEqual([id])
    granted = []
    expect(() => api.invoke({ kind: 'entity_action', id }, params)).toThrow(`PERMISSION_DENIED:${permission}`)
    expect(calls).toEqual([id])
  })

  test('role-filtered settings remain absent for invocation and snapshot', () => {
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      getInputs: () => ({ userRole: 'user', settingsTabs: [settings('operator', 'owner')], inputBarActions: [], extensionCommands: [] }),
    })
    expect(api.list(['settings_tab']).some((surface) => surface.id === 'operator')).toBeFalse()
    expect(() => api.invoke({ kind: 'settings_tab', id: 'operator' })).toThrow('HOST_ACTION_UNAVAILABLE')
  })

  test('subscriptions and target handlers are disposed with the generation', () => {
    const teardown: Array<() => void> = []
    const api = createHostSurfaceAPI({
      extensionId: 'ext-a',
      onTeardown: (handler) => { teardown.push(handler); return () => {} },
      getInputs: () => ({ userRole: 'user', drawerTabs: [drawer('profile')], inputBarActions: [], extensionCommands: [] }),
    })
    const events: unknown[] = []
    api.subscribe((surfaces) => events.push(surfaces))
    const target = api.registerDeepLinkTarget('lorebook', 'entry', (value) => events.push(value))
    target()
    teardown[0]()
    expect(() => api.list()).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(events).toHaveLength(0)
  })
})
