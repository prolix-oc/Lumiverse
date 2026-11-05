import { sortFolderGroups } from './folderSorting'
import type { AppStore } from '@/types/store'

const NO_RECENT_PERSONAS: string[] = []

export const selectRecentPersonaIds = (state: AppStore) =>
  state.showRecentPersonas !== false ? state.recentPersonaIds : NO_RECENT_PERSONAS

export interface PersonaFolderGroup<T> {
  folder: string
  personas: T[]
}

/**
 * Derive the shortcut and canonical page independently. Recently used personas
 * are supplemental shortcuts, not a filter over the folder browser.
 */
export function derivePersonaBrowserPage<T extends { id: string }>(
  personas: T[],
  recentPersonaIds: string[],
  currentPage: number,
  personasPerPage: number,
) {
  const recentById = new Map(personas.map((persona) => [persona.id, persona]))
  const recentPersonas = recentPersonaIds
    .map((id) => recentById.get(id))
    .filter((persona): persona is T => !!persona)

  const totalPages = Math.max(1, Math.ceil(personas.length / personasPerPage))
  const safePage = Math.max(1, Math.min(currentPage, totalPages))
  const start = (safePage - 1) * personasPerPage

  return {
    recentPersonas,
    paginatedPersonas: personas.slice(start, start + personasPerPage),
    safePage,
    totalPages,
  }
}

export function groupPersonasByFolder<T extends { folder?: string | null }>(
  personas: T[],
): Array<PersonaFolderGroup<T>> {
  const groups: Array<PersonaFolderGroup<T>> = []
  const folderMap = new Map<string, T[]>()

  for (const persona of personas) {
    const key = persona.folder || ''
    if (!folderMap.has(key)) {
      const folderPersonas: T[] = []
      folderMap.set(key, folderPersonas)
      groups.push({ folder: key, personas: folderPersonas })
    }
    folderMap.get(key)!.push(persona)
  }

  return sortFolderGroups(groups)
}

/**
 * Include persisted folders that have no persona anywhere in the collection,
 * then apply the same alphabetical ordering as populated folders. A populated
 * folder absent from the current page must not be presented as empty.
 */
export function includeEmptyPersonaFolders<T extends { folder?: string | null }>(
  groups: Array<PersonaFolderGroup<T>>,
  folders: string[],
  allPersonas: T[],
): Array<PersonaFolderGroup<T>> {
  const visibleFolders = new Set(groups.map((group) => group.folder))
  const populatedFolders = new Set(allPersonas.map((persona) => persona.folder || ''))
  const emptyGroups = folders
    .filter((folder) => folder && !visibleFolders.has(folder) && !populatedFolders.has(folder))
    .map((folder) => ({ folder, personas: [] as T[] }))

  return sortFolderGroups(emptyGroups.length > 0 ? [...groups, ...emptyGroups] : groups)
}
