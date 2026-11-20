import { useMemo } from 'react'
import { useStore } from '@/store'
import { generateUUID } from '@/lib/uuid'
import {
  assignConnectionFolder, connectionFolderId, connectionFolderName, deleteConnectionFolder,
  EMPTY_CONNECTION_LIBRARY, normalizeConnectionLibrary, orderedConnectionFolders,
  renameConnectionFolder, type ConnectionLibrary, type ConnectionLibraryKind,
} from '@/lib/connectionLibrary'

function currentLibrary(kind: ConnectionLibraryKind) {
  return normalizeConnectionLibrary(useStore.getState().connectionLibraries?.[kind])
}

function updateLibrary(kind: ConnectionLibraryKind, update: (value: ConnectionLibrary) => ConnectionLibrary) {
  const state = useStore.getState()
  if (state.fullSettingsLoaded === false) return
  state.setSetting('connectionLibraries', { ...state.connectionLibraries, [kind]: update(currentLibrary(kind)) })
}

/** Commit a form's folder draft only after its connection has saved successfully. */
export function saveConnectionFolder(kind: ConnectionLibraryKind, profileId: string, folderId: string) {
  updateLibrary(kind, value => assignConnectionFolder(value, profileId, folderId))
}

export function useConnectionLibrary(kind: ConnectionLibraryKind) {
  const ready = useStore(state => state.fullSettingsLoaded !== false)
  const stored = useStore(state => state.connectionLibraries?.[kind] ?? EMPTY_CONNECTION_LIBRARY)
  const library = useMemo(() => normalizeConnectionLibrary(stored), [stored])
  const folders = useMemo(() => orderedConnectionFolders(library), [library])
  return {
    library, folders, ready,
    folderId: (id: string) => connectionFolderId(library, id),
    folderName: (id: string) => connectionFolderName(library, id),
    findFolder: (name: string) => currentLibrary(kind).folders.find(folder => folder.name === name)?.id ?? '',
    createFolder(name: string) {
      const existing = currentLibrary(kind).folders.find(folder => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      if (existing) return existing.id
      const id = generateUUID()
      updateLibrary(kind, value => ({
        ...value, folders: [...value.folders, { id, name }],
        folderOrder: value.folderOrder.flatMap(folder => folder === '' ? [id, ''] : [folder]),
      }))
      return id
    },
    renameFolder: (id: string, name: string) => updateLibrary(kind, value => renameConnectionFolder(value, id, name)),
    deleteFolder: (id: string) => updateLibrary(kind, value => deleteConnectionFolder(value, id)),
    assign: (profileId: string, folderId: string) => saveConnectionFolder(kind, profileId, folderId),
    reorder: (folderOrder: string[]) => updateLibrary(kind, value => normalizeConnectionLibrary({ ...value, folderOrder })),
    reorderProfiles: (profileOrder: string[]) => updateLibrary(kind, value => ({ ...value, profileOrder })),
    copyFolder: (sourceId: string, targetId: string) => updateLibrary(kind, value => assignConnectionFolder(value, targetId, connectionFolderId(value, sourceId))),
    forget: (profileId: string) => updateLibrary(kind, value => assignConnectionFolder(value, profileId, '')),
  }
}
