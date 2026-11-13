import { describe, expect, test } from 'bun:test'
import {
  isQuickToolbarOverlayOpen,
  quickToolbarOverlayFingerprint,
  resolveQuickToolbarOverlayPresentation,
  shouldHideQuickToolbarWhenOverlaid,
} from '@/lib/uiProductivityDefaults'

const overlays = [
  'activeModal',
  'settingsModalOpen',
  'drawerOpen',
  'characterEditorOpen',
  'lorebookHalfEditorOpen',
  'lorebookWorkspaceOpen',
] as const

const base = {
  activeModal: null,
  settingsModalOpen: false,
  drawerOpen: false,
  characterEditorOpen: false,
  lorebookHalfEditorOpen: false,
  lorebookWorkspaceOpen: false,
}

function withOverlay(overlay: (typeof overlays)[number]) {
  return { ...base, [overlay]: overlay === 'activeModal' ? 'characterEditor' : true }
}

describe('Quick Toolbar overlay visibility', () => {
  test('uses the mobile-aware default for every real overlay surface', () => {
    for (const overlay of overlays) {
      const state = withOverlay(overlay)
      expect(isQuickToolbarOverlayOpen(state)).toBe(true)
      expect(shouldHideQuickToolbarWhenOverlaid({ ...state, hideWhenOverlaid: undefined, isMobile: true })).toBe(true)
      expect(shouldHideQuickToolbarWhenOverlaid({ ...state, hideWhenOverlaid: undefined, isMobile: false })).toBe(false)
    }
    expect(isQuickToolbarOverlayOpen(base)).toBe(false)
  })

  test('lets an explicit preference override the responsive default', () => {
    expect(shouldHideQuickToolbarWhenOverlaid({ ...base, drawerOpen: true, hideWhenOverlaid: true, isMobile: false })).toBe(true)
    expect(shouldHideQuickToolbarWhenOverlaid({ ...base, drawerOpen: true, hideWhenOverlaid: false, isMobile: true })).toBe(false)
  })

  test('treats modalRestoreHandle as hide-under-overlay on desktop', () => {
    for (const overlay of overlays) {
      const state = withOverlay(overlay)
      expect(shouldHideQuickToolbarWhenOverlaid({
        ...state,
        hideWhenOverlaid: undefined,
        isMobile: false,
        modalRestoreHandle: true,
      })).toBe(true)
      expect(shouldHideQuickToolbarWhenOverlaid({
        ...state,
        hideWhenOverlaid: false,
        isMobile: false,
        modalRestoreHandle: true,
      })).toBe(true)
    }
    expect(shouldHideQuickToolbarWhenOverlaid({
      ...base,
      hideWhenOverlaid: undefined,
      isMobile: false,
      modalRestoreHandle: true,
    })).toBe(false)
  })

  test('shows the restore tab for every overlay, not only activeModal', () => {
    for (const overlay of overlays) {
      const state = withOverlay(overlay)
      expect(resolveQuickToolbarOverlayPresentation({
        ...state,
        hideWhenOverlaid: undefined,
        isMobile: false,
        modalRestoreHandle: true,
        restoredOverModal: false,
      })).toBe('restore-tab')
    }
    expect(resolveQuickToolbarOverlayPresentation({
      ...base,
      settingsModalOpen: true,
      hideWhenOverlaid: undefined,
      isMobile: false,
      modalRestoreHandle: false,
      restoredOverModal: false,
    })).toBe('toolbar')
    expect(resolveQuickToolbarOverlayPresentation({
      ...base,
      settingsModalOpen: true,
      hideWhenOverlaid: true,
      isMobile: false,
      modalRestoreHandle: false,
      restoredOverModal: false,
    })).toBe('hidden')
  })

  test('bypasses hide after restore and resets when the overlay fingerprint changes', () => {
    const settingsOpen = {
      ...base,
      settingsModalOpen: true,
      hideWhenOverlaid: undefined,
      isMobile: false,
      modalRestoreHandle: true,
    }
    expect(resolveQuickToolbarOverlayPresentation({
      ...settingsOpen,
      restoredOverModal: true,
    })).toBe('toolbar')
    expect(resolveQuickToolbarOverlayPresentation({
      ...base,
      characterEditorOpen: true,
      hideWhenOverlaid: undefined,
      isMobile: false,
      modalRestoreHandle: true,
      restoredOverModal: false,
    })).toBe('restore-tab')
    expect(quickToolbarOverlayFingerprint({ ...base, settingsModalOpen: true }))
      .not.toBe(quickToolbarOverlayFingerprint(base))
    expect(quickToolbarOverlayFingerprint({ ...base, settingsModalOpen: true }))
      .not.toBe(quickToolbarOverlayFingerprint({ ...base, characterEditorOpen: true }))
    expect(quickToolbarOverlayFingerprint({ ...base, lorebookWorkspaceOpen: true }))
      .not.toBe(quickToolbarOverlayFingerprint({ ...base, lorebookHalfEditorOpen: true }))
  })
})
