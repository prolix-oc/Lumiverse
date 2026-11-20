import { describe, expect, test } from 'bun:test'
import { isSurfaceActive, isToolbarActionActive, type ToolbarUiState } from './quickToolbarToggle'

const idleUi: ToolbarUiState = {
  drawerOpen: false,
  drawerTab: null,
  settingsModalOpen: false,
  settingsActiveView: '',
}

const openDrawerUi: ToolbarUiState = {
  drawerOpen: true,
  drawerTab: 'lorebook',
  settingsModalOpen: false,
  settingsActiveView: '',
}

describe('isToolbarActionActive', () => {
  test('legacy Council buttons are active only in their corresponding view', () => {
    const ui: ToolbarUiState = { ...idleUi, drawerOpen: true, drawerTab: 'council', councilView: 'ooc' }
    expect(isSurfaceActive({ kind: 'drawer', tabId: 'ooc' }, ui)).toBe(true)
    expect(isSurfaceActive({ kind: 'drawer', tabId: 'feedback' }, ui)).toBe(false)
    expect(isSurfaceActive({ kind: 'drawer', tabId: 'council' }, ui)).toBe(true)
  })
  test('uses explicit active even for command surfaces', () => {
    expect(isToolbarActionActive(
      { surface: { kind: 'command' }, active: true },
      idleUi,
    )).toBe(true)
    expect(isToolbarActionActive(
      { surface: { kind: 'command' }, active: false },
      idleUi,
    )).toBe(false)
  })

  test('falls back to surface activity when active is undefined', () => {
    const drawer = { surface: { kind: 'drawer' as const, tabId: 'lorebook' } }
    expect(isToolbarActionActive(drawer, idleUi)).toBe(false)
    expect(isToolbarActionActive(drawer, openDrawerUi)).toBe(true)
    expect(isSurfaceActive(drawer.surface, openDrawerUi)).toBe(true)
    expect(isToolbarActionActive({ surface: { kind: 'command' } }, idleUi)).toBe(false)
  })
})
