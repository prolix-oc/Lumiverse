import { describe, expect, test } from 'bun:test'
import {
  getAvailableLandingPageTabs,
  normalizeLandingPageTab,
  resolveTabArrowKey,
} from './landingPageTabs'

describe('landing page tabs', () => {
  test('only offers Chats until the character surface is ready', () => {
    expect(getAvailableLandingPageTabs({ characterLibraryEnabled: false })).toEqual(['chats'])
    expect(getAvailableLandingPageTabs({ characterLibraryEnabled: true })).toEqual(['characters', 'chats'])
  })

  test('normalizes persisted selections against available tabs', () => {
    expect(normalizeLandingPageTab('characters', ['chats'])).toBe('chats')
    expect(normalizeLandingPageTab('chats', ['characters', 'chats'])).toBe('chats')
  })

  test('resolves roving tab-list keyboard navigation', () => {
    expect(resolveTabArrowKey('ArrowRight', 'characters')).toBe('chats')
    expect(resolveTabArrowKey('ArrowLeft', 'characters')).toBe('chats')
    expect(resolveTabArrowKey('End', 'characters')).toBe('chats')
    expect(resolveTabArrowKey('Enter', 'characters')).toBeNull()
  })
})
