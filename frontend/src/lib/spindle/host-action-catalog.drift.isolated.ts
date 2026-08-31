import { describe, expect, mock, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { frontendAuthorityRowFor } from './frontend-authority-map'

function sourceIds(source: string): string[] {
  return [...source.matchAll(/^\s+id:\s*'([^']+)'/gm)].map((match) => match[1])
}

const commandIds = sourceIds(await readFile(new URL('../commands.ts', import.meta.url), 'utf8'))
const drawerIds = sourceIds(await readFile(new URL('../drawer-tab-registry.tsx', import.meta.url), 'utf8'))
const settingsIds = sourceIds(await readFile(new URL('../settings-tab-registry.tsx', import.meta.url), 'utf8'))

const asCommand = (id: string) => ({
  id,
  label: id,
  description: id,
  keywords: [] as string[],
  group: 'actions',
  run: () => {},
})
const drawerTabs = drawerIds.map((id) => ({
  id,
  shortName: id,
  tabName: id,
  tabDescription: id,
  keywords: [] as string[],
}))
const settingsTabs = settingsIds.map((id) => ({
  id,
  shortName: id,
  tabName: id,
  tabDescription: id,
  keywords: [] as string[],
}))
const testStore = { user: null, drawerTabs: [], extensionCommands: [], inputBarActions: [] }

mock.module('@/lib/commands', () => ({ COMMANDS: commandIds.map(asCommand) }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: drawerTabs,
  extensionTabsToCommands: (tabs: Array<{ id: string }>) => tabs.map((tab) => asCommand(`panel-${tab.id}`)),
}))
mock.module('@/lib/settings-tab-registry', () => ({
  getVisibleSettingsTabs: () => settingsTabs,
  settingsRegistryToCommands: (tabs: Array<{ id: string }>) => tabs.map((tab) => asCommand(`settings-${tab.id}`)),
}))
mock.module('@/router', () => ({ router: { navigate: () => {} } }))
mock.module('@/store', () => ({
  useStore: Object.assign(() => testStore, {
    getState: () => testStore,
    subscribe: () => () => {},
  }),
}))
mock.module('@/ws/client', () => ({ wsClient: { send: () => {} } }))

const { buildHostSurfaceCatalog } = await import('./host-surfaces')

describe('H4 host action catalog authority totality', () => {
  test('every built-in catalog ref has a canonical host_action row', () => {
    const catalog = buildHostSurfaceCatalog({ userRole: 'owner' })
    for (const surface of catalog) {
      expect(
        frontendAuthorityRowFor({ surface: 'host_action', id: `${surface.kind}:${surface.id}` }),
        `${surface.kind}:${surface.id}`,
      ).toBeDefined()
    }
  })

  test('dynamic extension tab and command ids are classified without a wildcard free default', () => {
    const catalog = buildHostSurfaceCatalog({
      userRole: 'user',
      extensionTabs: [{ id: 'tab-a', extensionId: 'ext-a', title: 'A', badge: null, root: {} as HTMLElement }],
      extensionCommands: [{
        extensionId: 'ext-b',
        extensionName: 'B',
        commands: [{ id: 'cmd-b', label: 'B', description: 'B', externallyInvocable: true }],
      }],
    })
    for (const surface of catalog.filter((entry) => entry.kind === 'drawer_tab' || entry.kind === 'ext_command')) {
      expect(frontendAuthorityRowFor({ surface: 'host_action', id: `${surface.kind}:${surface.id}` })).toBeDefined()
    }
    expect(frontendAuthorityRowFor({ surface: 'host_action', id: 'command:synthetic' })).toBeUndefined()
  })
})
