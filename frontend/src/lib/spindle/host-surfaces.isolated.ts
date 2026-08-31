import { describe, expect, mock, test } from 'bun:test'
import type { ExtensionCommandState, InputBarActionState } from '@/store/slices/spindle-placement'

const COMMANDS = [
  ['action-new-chat', 'global'],
  ['action-delete-last-message', 'chat'],
  ['action-regenerate', 'chat-idle'],
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
}

mock.module('@/lib/commands', () => ({ COMMANDS }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: [],
  extensionTabsToCommands: () => [],
}))
mock.module('@/lib/settings-tab-registry', () => ({
  getVisibleSettingsTabs: () => [],
  settingsRegistryToCommands: () => [],
}))
mock.module('@/router', () => ({ router: { navigate: () => {} } }))
mock.module('@/store', () => ({
  useStore: Object.assign(() => testStore, {
    getState: () => testStore,
    subscribe: () => () => {},
  }),
}))
mock.module('@/ws/client', () => ({ wsClient: { send: () => {} } }))

const { buildHostSurfaceCatalog, createHostSurfaceAPI } = await import('./host-surfaces')

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
