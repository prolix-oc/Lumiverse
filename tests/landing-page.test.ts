import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_LANDING_PAGE_TAB,
  LANDING_PAGE_TABS,
  getAvailableLandingPageTabs,
  isLandingPageTab,
  landingPageTabId,
  landingPageTabPanelId,
  normalizeLandingPageTab,
  resolveTabArrowKey,
} from '../frontend/src/lib/landingPageTabs'

const libraryEnabled = { characterLibraryEnabled: true }
const libraryDisabled = { characterLibraryEnabled: false }

// The tab module is deliberately React-free so these state and keyboard decisions
// stay deterministic without a DOM or component renderer.
describe('landingPageTabs', () => {
  test('keeps the original library behind one suite-owned anchor and selects it first when ready', () => {
    const source = readFileSync(
      new URL('../frontend/src/components/landing/LandingPage.tsx', import.meta.url),
      'utf8',
    )

    expect(source).not.toContain("from './HomepageCharacterLibrary'")
    expect(source).not.toContain('<HomepageCharacterLibrary')
    expect(source.match(/data-spindle-mount="landing_characters"/g)).toHaveLength(1)
    expect(source.match(/data-spindle-mount="landing_chats"/g)).toHaveLength(1)
    expect(source).toContain('data-homepage-character-library-ready="true"')
    expect(source).toContain('data-recent-chats-ready="true"')
    expect(source).toContain("setRequestedLandingTab('characters')")
    expect(source).not.toContain("setSetting('landingPageActiveTab'")
  })

  test('uses Characters as the default and keeps persisted Chats valid', () => {
    expect([...LANDING_PAGE_TABS]).toEqual(['characters', 'chats'])
    expect(DEFAULT_LANDING_PAGE_TAB).toBe('characters')
    expect(isLandingPageTab('characters')).toBe(true)
    expect(isLandingPageTab('chats')).toBe(true)

    expect(normalizeLandingPageTab(undefined)).toBe('characters')
    expect(normalizeLandingPageTab('chats')).toBe('chats')
    expect(normalizeLandingPageTab('characters')).toBe('characters')
  })

  test('falls back invalid settings values to Characters', () => {
    for (const value of [undefined, null, '', 'CHATS', 'favourites', 7, {}, ['chats']]) {
      expect(normalizeLandingPageTab(value)).toBe('characters')
      expect(isLandingPageTab(value)).toBe(false)
    }
  })

  test('normalizes an unavailable stored tab for rendering without changing the stored value', () => {
    const chatsOnly = getAvailableLandingPageTabs(libraryDisabled)
    const storedTab = 'characters'

    expect([...getAvailableLandingPageTabs(libraryEnabled)]).toEqual(['characters', 'chats'])
    expect([...chatsOnly]).toEqual(['chats'])
    expect(normalizeLandingPageTab(storedTab, chatsOnly)).toBe('chats')
    expect(normalizeLandingPageTab('chats', chatsOnly)).toBe('chats')
    expect(storedTab).toBe('characters')
  })

  test('builds stable, distinct tab and panel ids', () => {
    const ids = LANDING_PAGE_TABS.flatMap((tab) => [landingPageTabId(tab), landingPageTabPanelId(tab)])

    expect(new Set(ids).size).toBe(ids.length)
    expect(landingPageTabId('chats')).toBe('landing-tab-chats')
    expect(landingPageTabPanelId('chats')).toBe('landing-tabpanel-chats')
    expect(landingPageTabId('characters')).not.toBe(landingPageTabPanelId('characters'))
  })

  test('wraps ArrowLeft and ArrowRight across the full tablist', () => {
    expect(resolveTabArrowKey('ArrowRight', 'characters')).toBe('chats')
    expect(resolveTabArrowKey('ArrowRight', 'chats')).toBe('characters')
    expect(resolveTabArrowKey('ArrowLeft', 'chats')).toBe('characters')
    expect(resolveTabArrowKey('ArrowLeft', 'characters')).toBe('chats')
  })

  test('Home and End resolve the first and last available tabs', () => {
    for (const tab of LANDING_PAGE_TABS) {
      expect(resolveTabArrowKey('Home', tab)).toBe('characters')
      expect(resolveTabArrowKey('End', tab)).toBe('chats')
    }

    const chatsOnly = getAvailableLandingPageTabs(libraryDisabled)
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(resolveTabArrowKey(key, 'chats', chatsOnly)).toBe('chats')
      expect(resolveTabArrowKey(key, 'characters', chatsOnly)).toBe('chats')
    }
  })

  test('returns null for keys outside the tablist contract', () => {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', 'ArrowUp', 'ArrowDown', 'PageUp']) {
      expect(resolveTabArrowKey(key, 'characters')).toBeNull()
      expect(resolveTabArrowKey(key, 'characters', ['chats'])).toBeNull()
    }
  })
})
