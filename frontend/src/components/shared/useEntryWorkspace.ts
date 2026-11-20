import { useCallback, useState, type SetStateAction } from 'react'
import type { WorldBookEntry } from '@/types/api'

export interface EntryWorkspaceState { entries: WorldBookEntry[]; cached: WorldBookEntry[]; openIds: string[] }
export function changeWorkspaceEntries(state: EntryWorkspaceState, change: SetStateAction<WorldBookEntry[]>): EntryWorkspaceState {
  const entries = typeof change === 'function' ? change(state.entries) : change
  // Page replacement is navigation. It must not evict open objects. Mutations
  // apply to both collections so revisions, conflicts and deletion stay shared.
  const cached = typeof change === 'function' ? change(state.cached) : state.cached.map(entry => entries.find(value => value.id === entry.id) ?? entry)
  const ids = new Set(cached.map(entry => entry.id))
  return { entries, cached, openIds: state.openIds.filter(id => ids.has(id)) }
}
export function useEntryWorkspace() {
  const [state, setState] = useState<EntryWorkspaceState>({ entries: [], cached: [], openIds: [] })
  const setEntries = useCallback((change: SetStateAction<WorldBookEntry[]>) => setState(current => changeWorkspaceEntries(current, change)), [])
  const open = useCallback((id: string, source?: WorldBookEntry) => setState(current => {
    if (current.openIds.includes(id)) return current
    const entry = source ?? current.cached.find(value => value.id === id) ?? current.entries.find(value => value.id === id)
    if (!entry) return current
    return { ...current, cached: current.cached.some(value => value.id === id) ? current.cached : [...current.cached, entry], openIds: [...current.openIds, id] }
  }), [])
  const close = useCallback((id: string) => setState(current => ({ ...current, openIds: current.openIds.filter(value => value !== id) })), [])
  return { ...state, setEntries, open, close }
}
