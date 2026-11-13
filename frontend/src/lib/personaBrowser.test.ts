import { describe, expect, test } from 'bun:test'

import {
  derivePersonaBrowserPage,
  groupPersonasByFolder,
  includeEmptyPersonaFolders,
  selectRecentPersonaIds,
} from './personaBrowser'
import type { AppStore } from '@/types/store'

interface TestPersona {
  id: string
  folder?: string
}

describe('persona browser derivation', () => {
  test('the hidden-persona selector stays stable across history changes without deleting history', () => {
    const state = { showRecentPersonas: false, recentPersonaIds: ['one'] } as AppStore
    const hidden = selectRecentPersonaIds(state)
    expect(hidden).toEqual([])
    expect(selectRecentPersonaIds({ ...state, recentPersonaIds: ['two', 'one'] })).toBe(hidden)
    expect(state.recentPersonaIds).toEqual(['one'])
    expect(selectRecentPersonaIds({ ...state, showRecentPersonas: true })).toBe(state.recentPersonaIds)
  })

  test('recent personas remain in their canonical folder page', () => {
    const personas: TestPersona[] = [
      { id: 'recent-foldered', folder: 'Friends' },
      { id: 'recent-uncategorized' },
      { id: 'other', folder: 'Work' },
    ]

    const page = derivePersonaBrowserPage(
      personas,
      ['recent-foldered', 'recent-uncategorized'],
      1,
      10,
    )
    const groups = groupPersonasByFolder(page.paginatedPersonas)

    expect(page.recentPersonas.map((persona) => persona.id)).toEqual([
      'recent-foldered',
      'recent-uncategorized',
    ])
    expect(page.paginatedPersonas.map((persona) => persona.id)).toEqual([
      'recent-foldered',
      'recent-uncategorized',
      'other',
    ])
    expect(groups.map((group) => [group.folder, group.personas.map((persona) => persona.id)])).toEqual([
      ['Friends', ['recent-foldered']],
      ['Work', ['other']],
      ['', ['recent-uncategorized']],
    ])
  })

  test('sorts folders alphabetically without changing persona order within them', () => {
    const personas: TestPersona[] = [
      { id: 'zulu-first', folder: 'Zulu' },
      { id: 'uncategorized' },
      { id: 'alpha', folder: 'Alpha' },
      { id: 'zulu-second', folder: 'Zulu' },
      { id: 'middle', folder: 'Middle' },
    ]

    const groups = groupPersonasByFolder(personas)

    expect(groups.map((group) => [group.folder, group.personas.map((persona) => persona.id)])).toEqual([
      ['Alpha', ['alpha']],
      ['Middle', ['middle']],
      ['Zulu', ['zulu-first', 'zulu-second']],
      ['', ['uncategorized']],
    ])
  })

  test('recent shortcuts do not reduce the canonical page count', () => {
    const personas = Array.from({ length: 6 }, (_, index) => ({ id: `persona-${index}` }))
    const page = derivePersonaBrowserPage(
      personas,
      personas.slice(0, 5).map((persona) => persona.id),
      2,
      3,
    )

    expect(page.totalPages).toBe(2)
    expect(page.paginatedPersonas.map((persona) => persona.id)).toEqual([
      'persona-3',
      'persona-4',
      'persona-5',
    ])
  })

  test('persisted folders remain visible before they contain a persona', () => {
    const personas: TestPersona[] = [{ id: 'uncategorized' }]
    const groups = groupPersonasByFolder(personas)
    const visibleGroups = includeEmptyPersonaFolders(groups, ['Empty folder'], personas)

    expect(visibleGroups.map((group) => [group.folder, group.personas.length])).toEqual([
      ['Empty folder', 0],
      ['', 1],
    ])
  })

  test('does not label a populated folder as empty when its personas are on another page', () => {
    const allPersonas: TestPersona[] = [
      { id: 'first-page' },
      { id: 'later-page', folder: 'Populated folder' },
    ]
    const groups = groupPersonasByFolder(allPersonas.slice(0, 1))
    const visibleGroups = includeEmptyPersonaFolders(groups, ['Populated folder'], allPersonas)

    expect(visibleGroups.map((group) => group.folder)).toEqual([''])
  })
})
