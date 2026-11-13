import type { Character } from '@/types/api'

export function reconcileLoadedCharacters(
  previousIds: ReadonlySet<string>,
  loaded: Character[],
  current: Character[],
): Character[] {
  const loadedIds = new Set(loaded.map((character) => character.id))
  const addedDuringLoad = current.filter(
    (character) => !previousIds.has(character.id) && !loadedIds.has(character.id),
  )
  return [...addedDuringLoad, ...loaded]
}
