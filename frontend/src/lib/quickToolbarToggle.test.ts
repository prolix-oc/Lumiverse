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
