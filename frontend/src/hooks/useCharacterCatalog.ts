import { useEffect } from 'react'
import { charactersApi } from '@/api/characters'
import { useStore } from '@/store'
import { readAccountEpoch } from '@/lib/shared-read'

let flight: { key: string; request: Promise<void> } | null = null

/** Bulk imports refresh only full documents already demanded by a view. */
export async function refreshCachedCharacters(): Promise<void> {
  const state = useStore.getState()
  const userId = state.user?.id
  if (!userId || !state.isAuthenticated) return
  const epoch = readAccountEpoch()
  const generation = state.characterIndexGeneration
  const cached = state.characters
  for (let offset = 0; offset < cached.length; offset += 100) {
    const originals = cached.slice(offset, offset + 100)
    const items = await charactersApi.getBatch(originals.map(item => item.id))
    const current = useStore.getState()
    if (readAccountEpoch() !== epoch || current.user?.id !== userId || !current.isAuthenticated
      || current.characterIndexGeneration !== generation) return
    const byId = new Map(items.map(item => [item.id, item]))
    for (const original of originals) {
      // A newer edit/delete event owns its document even if this read finishes later.
      if (useStore.getState().characters.find(item => item.id === original.id) !== original) continue
      const item = byId.get(original.id)
      if (item) current.updateCharacter(item.id, item)
      else current.removeCharacter(original.id)
    }
  }
}

export async function loadCharacterIndex(force = false): Promise<void> {
  if (force) useStore.getState().invalidateCharacterIndex()
  const state = useStore.getState()
  const userId = state.user?.id
  if (!userId || !state.isAuthenticated || (!force && state.characterIndexLoaded)) return
  const revision = state.characterIndexRevision
  const generation = state.characterIndexGeneration
  const epoch = readAccountEpoch()
  const key = `${epoch}:${userId}:${generation}`
  if (flight?.key === key) return flight.request
  const request = charactersApi.listIndex(generation).then(items => {
    const current = useStore.getState()
    if (readAccountEpoch() === epoch && current.user?.id === userId && current.isAuthenticated
      && current.characterIndexGeneration === generation) current.setCharacterIndex(items, revision)
  })
  const owner = { key, request }
  flight = owner
  const release = () => { if (flight === owner) flight = null }
  void request.then(release, release)
  return request
}

/** Picker data never pretends to be a complete character document. */
export function useCharacterCatalog() {
  const userId = useStore(state => state.user?.id)
  const index = useStore(state => state.characterIndex)
  const loaded = useStore(state => state.characterIndexLoaded)
  const generation = useStore(state => state.characterIndexGeneration)
  useEffect(() => { void loadCharacterIndex().catch(error => console.warn('[character-index]', error)) }, [userId, loaded, generation])
  return index
}
