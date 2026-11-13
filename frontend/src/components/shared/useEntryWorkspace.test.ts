import { describe, expect, test } from 'bun:test'
import { changeWorkspaceEntries, type EntryWorkspaceState } from './useEntryWorkspace'
import type { WorldBookEntry } from '@/types/api'
const entry = (id: string, revision = 1) => ({ id, revision, content: id, folder: id } as WorldBookEntry)
const state = (): EntryWorkspaceState => ({ entries: [entry('Characters')], cached: [entry('Characters'), entry('Plot')], openIds: ['Characters', 'Plot'] })
describe('workspace entries independent of navigator pages', () => {
  test('folder/page replacement retains open entries while refreshing matching revisions', () => {
    const next = changeWorkspaceEntries(state(), [entry('Plot', 3)])
    expect(next.entries.map(value => value.id)).toEqual(['Plot'])
    expect(next.openIds).toEqual(['Characters', 'Plot'])
    expect(next.cached.map(value => [value.id, value.revision])).toEqual([['Characters', 1], ['Plot', 3]])
  })
  test('editing an off-page tab patches the same object and revision path', () => {
    const next = changeWorkspaceEntries(state(), current => current.map(value => value.id === 'Plot' ? { ...value, content: 'draft', revision: 4 } : value))
    expect(next.entries[0].content).toBe('Characters')
    expect(next.cached[1]).toMatchObject({ content: 'draft', revision: 4 })
  })
  test('confirmed deletion evicts the cached object and tab, without touching other tabs', () => {
    const next = changeWorkspaceEntries(state(), current => current.filter(value => value.id !== 'Plot'))
    expect(next.openIds).toEqual(['Characters'])
    expect(next.cached.map(value => value.id)).toEqual(['Characters'])
  })
})
