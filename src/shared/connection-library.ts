type ConnectionKind = 'llm' | 'imageGen' | 'tts' | 'stt' | 'decision'

export type ConnectionLibraryKind = ConnectionKind | 'embedding'
export interface ConnectionFolder { id: string; name: string }
export interface ConnectionLibrary {
  folders: ConnectionFolder[]
  /** Includes the empty ID for Uncategorized, which can also be reordered. */
  folderOrder: string[]
  assignments: Record<string, string>
  /** Personal ordering for inherited embedding profiles; never changes their configuration. */
  profileOrder?: string[]
}
export type ConnectionLibraries = Partial<Record<ConnectionLibraryKind, ConnectionLibrary>>

export const EMPTY_CONNECTION_LIBRARY: ConnectionLibrary = { folders: [], folderOrder: [''], assignments: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeConnectionLibrary(value: unknown): ConnectionLibrary {
  if (!isRecord(value)) return EMPTY_CONNECTION_LIBRARY
  const folders: ConnectionFolder[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const folder of Array.isArray(value.folders) ? value.folders : []) {
    if (!isRecord(folder) || typeof folder.id !== 'string' || !folder.id
      || typeof folder.name !== 'string' || !folder.name.trim()) continue
    const name = folder.name.trim()
    if (ids.has(folder.id) || names.has(name.toLocaleLowerCase())) continue
    ids.add(folder.id)
    names.add(name.toLocaleLowerCase())
    folders.push({ id: folder.id, name })
  }
  const folderOrder = [...new Set((Array.isArray(value.folderOrder) ? value.folderOrder : [])
    .filter((id): id is string => typeof id === 'string' && (id === '' || ids.has(id))))]
  for (const { id } of folders) if (!folderOrder.includes(id)) folderOrder.push(id)
  if (!folderOrder.includes('')) folderOrder.push('')
  const assignments = Object.fromEntries(Object.entries(isRecord(value.assignments) ? value.assignments : {})
    .filter(([id, folder]) => id && typeof folder === 'string' && ids.has(folder))) as Record<string, string>
  const profileOrder = Array.isArray(value.profileOrder)
    ? [...new Set(value.profileOrder.filter((id): id is string => typeof id === 'string' && !!id))]
    : undefined
  return { folders, folderOrder, assignments, ...(profileOrder ? { profileOrder } : {}) }
}

export function connectionFolderId(library: ConnectionLibrary, profileId: string): string {
  const id = Object.hasOwn(library.assignments, profileId) ? library.assignments[profileId] : ''
  return library.folders.some(folder => folder.id === id) ? id : ''
}

export function connectionFolderName(library: ConnectionLibrary, profileId: string): string {
  const id = connectionFolderId(library, profileId)
  return library.folders.find(folder => folder.id === id)?.name ?? ''
}

export function renameConnectionFolder(library: ConnectionLibrary, id: string, name: string): ConnectionLibrary {
  return { ...library, folders: library.folders.map(folder => folder.id === id ? { ...folder, name } : folder) }
}

export function deleteConnectionFolder(library: ConnectionLibrary, id: string): ConnectionLibrary {
  return {
    ...library,
    folders: library.folders.filter(folder => folder.id !== id),
    folderOrder: library.folderOrder.filter(folderId => folderId !== id),
    assignments: Object.fromEntries(Object.entries(library.assignments).filter(([, folder]) => folder !== id)),
  }
}

export function assignConnectionFolder(library: ConnectionLibrary, profileId: string, folderId: string): ConnectionLibrary {
  const assignments = { ...library.assignments }
  if (folderId && library.folders.some(folder => folder.id === folderId)) assignments[profileId] = folderId
  else delete assignments[profileId]
  return { ...library, assignments }
}

export function orderedConnectionFolders(library: ConnectionLibrary): ConnectionFolder[] {
  const byId = new Map(library.folders.map(folder => [folder.id, folder]))
  return library.folderOrder.map(id => byId.get(id) ?? { id: '', name: '' })
}

export function validConnectionFolderName(library: ConnectionLibrary, name: string, uncategorized: string, id?: string): boolean {
  const normalized = name.trim().toLocaleLowerCase()
  return !!normalized && name.trim().length <= 64
    && !['uncategorized', uncategorized.toLocaleLowerCase()].includes(normalized)
    && !library.folders.some(folder => folder.id !== id && folder.name.toLocaleLowerCase() === normalized)
}

