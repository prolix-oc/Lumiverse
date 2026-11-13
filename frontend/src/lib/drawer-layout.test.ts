import { describe, expect, test } from 'bun:test'
import type { DrawerLayoutItem, DrawerSettings } from '@/types/store'
import {
  canonicalDrawerLayoutTabId,
  createDefaultDrawerLayout,
  drawerLayoutItemKey,
  moveDrawerLayoutItem,
  reconcileDrawerLayout,
  reconcileExtensionDrawerSettings,
  removeDrawerLayoutContainer,
  sanitizeDrawerLayout,
  updateDrawerLayoutFolderView,
} from './drawer-layout'

describe('drawer layout', () => {
  test('removes uninstalled extension references from root, folders, order and visibility', () => {
    const oldTab = 'spindle:old-install:tab:main:17'
    const liveTab = 'spindle:live-install:tab:nested:tab:main:41'
    const folder: Extract<DrawerLayoutItem, { type: 'folder' }> = {
      type: 'folder', id: 'favorites', name: 'Favorites', icon: 'game', view: 'grid', children: [oldTab, liveTab, 'profile'],
    }
    const emptyFolder: Extract<DrawerLayoutItem, { type: 'folder' }> = {
      type: 'folder', id: 'empty', name: 'Keep me', children: [oldTab],
    }
    const settings = {
      side: 'left',
      layout: [
        { type: 'tab', tabId: oldTab },
        { type: 'divider', id: 'tools', label: 'Tools' },
        folder,
        emptyFolder,
        { type: 'tab', tabId: 'unknown-host-tab' },
      ],
      tabOrder: [oldTab, liveTab, 'profile'],
      hiddenTabIds: [oldTab, liveTab, 'regex'],
    } as DrawerSettings
    const next = reconcileExtensionDrawerSettings(settings, new Set(['live-install']))
    expect(next).toEqual({
      ...settings,
      layout: [
        settings.layout[1],
        { ...folder, children: [liveTab, 'profile'] },
        { ...emptyFolder, children: [] },
        settings.layout[4],
      ],
      tabOrder: [liveTab, 'profile'],
      hiddenTabIds: [liveTab, 'regex'],
    })
    expect(settings.hiddenTabIds).toEqual([oldTab, liveTab, 'regex'])
    expect(reconcileExtensionDrawerSettings(next, new Set(['live-install']))).toBe(next)
  })

  test('prunes legacy order and visibility without materializing a layout', () => {
    const settings = {
      tabOrder: ['profile', 'spindle:removed:tab:main', 'spindle:installed:tab:main:9'],
      hiddenTabIds: ['spindle:removed:tab:main:12'],
    } as DrawerSettings
    const next = reconcileExtensionDrawerSettings(settings, new Set(['installed']))
    expect(next.tabOrder).toEqual(['profile', 'spindle:installed:tab:main:9'])
    expect(next.hiddenTabIds).toEqual([])
    expect(next.layout).toBeUndefined()
  })

  test('keeps settings unchanged when every Spindle owner is installed', () => {
    const settings = {
      layout: [{ type: 'folder', id: 'tools', name: 'Tools', children: ['spindle:installed:tab:main:17', 'profile'] }],
      tabOrder: ['spindle:installed:tab:main'], hiddenTabIds: ['spindle:installed:tab:main:17'],
    } as DrawerSettings
    expect(reconcileExtensionDrawerSettings(settings, new Set(['installed']))).toBe(settings)
  })

  test('retires Council subpages from saved folders and legacy tab order', () => {
    const layout = reconcileDrawerLayout({
      layout: [{ type: 'folder', id: 'council-folder', name: 'Council', children: ['council', 'prompt', 'ooc', 'feedback', 'create'] }],
      builtInIds: ['council', 'create'], extensionIds: [],
    })
    expect(layout).toEqual([{ type: 'folder', id: 'council-folder', name: 'Council', children: ['council', 'prompt', 'create'] }])
    expect(createDefaultDrawerLayout({ builtInIds: ['council', 'prompt', 'create'], extensionIds: [], legacyTabOrder: ['feedback', 'ooc', 'prompt', 'council', 'create'] }))
      .toEqual([{ type: 'tab', tabId: 'prompt' }, { type: 'tab', tabId: 'council' }, { type: 'tab', tabId: 'create' }])
  })

  test('canonicalizes Spindle drawer IDs across reload counters', () => {
    expect(canonicalDrawerLayoutTabId('spindle:macro-lab:tab:main:17')).toBe('spindle:macro-lab:tab:main')
    expect(canonicalDrawerLayoutTabId('spindle:macro-lab:tab:nested:tab:id:204')).toBe('spindle:macro-lab:tab:nested:tab:id')
    expect(canonicalDrawerLayoutTabId('profile')).toBe('profile')
  })

  test('keeps an extension in its folder when the runtime registration counter changes', () => {
    expect(reconcileDrawerLayout({
      layout: [
        {
          type: 'folder',
          id: 'gimmicks',
          name: 'Gimmicks',
          icon: 'game',
          children: ['spindle:macro-lab:tab:main:17'],
        },
      ],
      builtInIds: ['profile'],
      extensionIds: ['spindle:macro-lab:tab:main:41'],
    })).toEqual([
      {
        type: 'folder',
        id: 'gimmicks',
        name: 'Gimmicks',
        icon: 'game',
        children: ['spindle:macro-lab:tab:main'],
      },
      { type: 'tab', tabId: 'profile' },
    ])
  })
  test('migrates the legacy split order into tabs + the default extension divider', () => {
    expect(createDefaultDrawerLayout({
      builtInIds: ['profile', 'lorebook'],
      extensionIds: ['macro', 'regex-plus'],
      legacyTabOrder: ['lorebook', 'profile', 'regex-plus', 'macro'],
    })).toEqual([
      { type: 'tab', tabId: 'lorebook' },
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      { type: 'tab', tabId: 'regex-plus' },
      { type: 'tab', tabId: 'macro' },
    ])
  })

  test('keeps unavailable legacy tab IDs during first migration', () => {
    expect(createDefaultDrawerLayout({
      builtInIds: ['profile'],
      extensionIds: ['live-extension'],
      legacyTabOrder: ['profile', 'missing-extension', 'live-extension'],
    })).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      { type: 'tab', tabId: 'missing-extension' },
      { type: 'tab', tabId: 'live-extension' },
    ])
  })

  test('preserves unavailable saved tabs and appends newly discovered tabs at root', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro-missing', 'regex'] },
      { type: 'divider', id: 'writing', label: 'Writing' },
      { type: 'tab', tabId: 'profile' },
    ]

    expect(reconcileDrawerLayout({
      layout,
      builtInIds: ['profile', 'lorebook'],
      extensionIds: ['regex', 'new-tool'],
    })).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro-missing', 'regex'] },
      { type: 'divider', id: 'writing', label: 'Writing' },
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'lorebook' },
      { type: 'tab', tabId: 'new-tool' },
    ])
  })

  test('preserves per-folder view and sanitizes structured custom SVG data', () => {
    expect(sanitizeDrawerLayout([
      {
        type: 'folder',
        id: 'memory',
        name: 'Memory',
        view: 'grid',
        customIcon: {
          viewBox: '0 0 24 24',
          attrs: { fill: '#ffffff', onClick: 'nope' },
          elements: [
            { tag: 'path', attrs: { d: 'M2 2L22 22', stroke: '#ff00ff', onClick: 'nope' } },
          ],
        },
        children: ['lorebook'],
      },
    ])).toEqual([
      {
        type: 'folder',
        id: 'memory',
        name: 'Memory',
        customIcon: {
          viewBox: '0 0 24 24',
          attrs: { fill: 'currentColor', stroke: 'none' },
          elements: [
            { tag: 'path', attrs: { d: 'M2 2L22 22', stroke: 'currentColor' } },
          ],
        },
        view: 'grid',
        children: ['lorebook'],
      },
    ])
  })

  test('updates folder view without disturbing children or icon settings', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'memory', name: 'Memory', icon: 'brain', children: ['lorebook'] },
    ]
    expect(updateDrawerLayoutFolderView(layout, 'folder:memory', 'grid')).toEqual([
      { type: 'folder', id: 'memory', name: 'Memory', icon: 'brain', view: 'grid', children: ['lorebook'] },
    ])
  })

  test('deduplicates tabs across root and folders while keeping first placement', () => {
    expect(sanitizeDrawerLayout([
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['profile', 'regex', 'regex'] },
      { type: 'tab', tabId: 'regex' },
    ])).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
    ])
  })

  test('moves a root tab into a folder', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:profile', 'folder:tools')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'profile'] },
    ])
  })

  test('promotes a folder child to root when dropped on a root tab', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:regex', 'tab:profile')).toEqual([
      { type: 'tab', tabId: 'regex' },
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro'] },
    ])
  })

  test('moves a tab between folders using a child as the target', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'one', name: 'One', children: ['a', 'b'] },
      { type: 'folder', id: 'two', name: 'Two', children: ['c'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:b', 'tab:c')).toEqual([
      { type: 'folder', id: 'one', name: 'One', children: ['a'] },
      { type: 'folder', id: 'two', name: 'Two', children: ['b', 'c'] },
    ])
  })

  test('reorders root dividers and folders without nesting them', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'divider', id: 'one' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
      { type: 'tab', tabId: 'profile' },
    ]
    expect(moveDrawerLayoutItem(layout, 'divider:one', 'tab:profile')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'one' },
    ])
  })

  test('root-end drop promotes a folder child to the end of the root list', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
      { type: 'tab', tabId: 'profile' },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:regex', 'drawer-layout:root-end')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro'] },
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'regex' },
    ])
  })

  test('deleting a folder spills its children back into the same root position', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
      { type: 'divider', id: 'after' },
    ]
    expect(removeDrawerLayoutContainer(layout, drawerLayoutItemKey(layout[1]))).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'regex' },
      { type: 'tab', tabId: 'macro' },
      { type: 'divider', id: 'after' },
    ])
  })
})
