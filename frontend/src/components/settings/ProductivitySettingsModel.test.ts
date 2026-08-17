import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LOREBOOK_EDITOR_SETTINGS,
  DEFAULT_QUICK_TOOLBAR_SETTINGS,
  normalizeLoreIndicatorEntryTypeAppearance,
  PRODUCTIVITY_DEFAULTS,
} from '@/lib/uiProductivityDefaults'
import { bindProductivitySetting, parseProductivityNumber, PRODUCTIVITY_CONTROL_DEFINITIONS, PRODUCTIVITY_SETTING_KEYS, moveVisibleToolbarItem, normalizeColor, previewForSetting, reorderItems, setToolbarItemVisibility } from './ProductivitySettingsModel'

describe('P8 productivity panel model', () => {
  test('covers all seven immutable defaults and every declared control', () => {
    expect(PRODUCTIVITY_SETTING_KEYS).toHaveLength(7)
    for (const key of PRODUCTIVITY_SETTING_KEYS) {
      expect(PRODUCTIVITY_DEFAULTS[key]).toBeDefined()
      expect(Object.isFrozen(PRODUCTIVITY_DEFAULTS[key])).toBe(true)
      expect(PRODUCTIVITY_CONTROL_DEFINITIONS[key].length).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(DEFAULT_QUICK_TOOLBAR_SETTINGS.visibleTabIds)).toBe(true)
  })

  test('reorders without mutating the persisted source array', () => {
    const source = ['a', 'b', 'c']
    expect(reorderItems(source, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(source).toEqual(['a', 'b', 'c'])
  })

  test('binds patches immutably for persisted settings', () => {
    const source = { enabled: true, rect: { width: 10 } }
    const bound = bindProductivitySetting(source, { enabled: false })
    expect(bound).toEqual({ enabled: false, rect: { width: 10 } })
    expect(source.enabled).toBe(true)
  })

  test('normalizes hex and rgb colors with a safe fallback', () => {
    expect(normalizeColor('#abc')).toBe('#AABBCC')
    expect(normalizeColor('rgb(1, 2, 255)')).toBe('#0102FF')
    expect(normalizeColor('not-a-color', '#123456')).toBe('#123456')
    expect(normalizeColor(null, '#123456')).toBe('#123456')
  })

  test('provides previews for each persisted surface', () => {
    for (const key of PRODUCTIVITY_SETTING_KEYS) {
      expect(previewForSetting(key, PRODUCTIVITY_DEFAULTS[key])).toBeDefined()
    }
  })

  test('default migration fields remain available to every control', () => {
    expect(DEFAULT_QUICK_TOOLBAR_SETTINGS.rectVersion).toBe(1)
    expect(DEFAULT_LOREBOOK_EDITOR_SETTINGS.halfEditorMode).toBe('docked')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.lorebookEditorSettings).toContain('halfEditorMode')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.lorebookEditorSettings).toContain('fullEditorLaunchMode')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.connectionsPickerSettings).toContain('profileTags')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).toContain('iconOrder')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).toContain('hideWhenOverlaid')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).toContain('fillTopDockWidth')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).toContain('showNativeSelectMessages')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).toContain('opaqueToolbarBackdrop')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings).not.toContain('hideInChatTopDock')
    expect(PRODUCTIVITY_CONTROL_DEFINITIONS.loreIndicatorSettings).toContain('editorLaunchTarget')
    expect(DEFAULT_QUICK_TOOLBAR_SETTINGS.hideWhenOverlaid).toBeUndefined()
    expect(DEFAULT_QUICK_TOOLBAR_SETTINGS.hideInChatTopDock).toBe(false)
    expect(DEFAULT_QUICK_TOOLBAR_SETTINGS.showNativeSelectMessages).toBe(true)
    expect(DEFAULT_QUICK_TOOLBAR_SETTINGS.opaqueToolbarBackdrop).toBe(false)
  })

  test('parses precise numeric edits without escaping the control range', () => {
    expect(parseProductivityNumber('12', { fallback: 23, min: 16, max: 36, step: 1 })).toBe(16)
    expect(parseProductivityNumber('99', { fallback: 23, min: 16, max: 36, step: 1 })).toBe(36)
    expect(parseProductivityNumber('not a number', { fallback: 23, min: 16, max: 36, step: 1 })).toBe(23)
    expect(parseProductivityNumber('0.375', { fallback: 0.2, min: 0, max: 1, step: 0.01 })).toBe(0.38)
  })

  test('reorders visible toolbar items without dropping a hidden item', () => {
    const iconOrder = ['profile', 'connections', 'lorebook', 'settings']
    const visibleTabIds = ['profile', 'lorebook', 'settings']
    const reordered = moveVisibleToolbarItem(iconOrder, visibleTabIds, iconOrder, 'settings', -1)

    expect(reordered).toEqual(['profile', 'connections', 'settings', 'lorebook'])
    expect(reordered).toContain('connections')
    expect([...visibleTabIds, 'connections'].filter((id) => reordered.includes(id))).toContain('connections')
    expect(setToolbarItemVisibility(reordered, visibleTabIds, 'connections', true)).toEqual(['profile', 'lorebook', 'settings', 'connections'])
    expect(setToolbarItemVisibility(reordered, ['profile', 'lorebook', 'settings', 'connections'], 'connections', false)).toEqual(['profile', 'lorebook', 'settings'])
  })

  test('normalizes malformed legacy lore appearance rows to complete canonical defaults', () => {
    expect(normalizeLoreIndicatorEntryTypeAppearance({
      constant: { color: '#112233' },
      keyword: { icon: 'key' },
      vector: null,
    })).toEqual({
      constant: { color: '#112233', icon: 'pin' },
      sticky: { color: '#EC4899', icon: 'clock' },
      keyword: { color: '#3B82F6', icon: 'key' },
      vector: { color: '#8B5CF6', icon: 'search' },
    })
  })
})
