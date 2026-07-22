import { useState, useEffect, useCallback, useMemo } from 'react'
import { settingsApi } from '@/api/settings'

type FolderSettingsKey = 'characterFolders' | 'personaFolders' | 'regexScriptFolders' | 'worldBookFolders'
const FOLDERS_UPDATED_EVENT = 'lumiverse:folders-updated'

interface FoldersUpdatedDetail {
  settingsKey: FolderSettingsKey
  folders: string[]
}

/**
 * Manages folder names backed by a settings key, merged with folders
 * discovered from existing items.
 */
export function useFolders(
  settingsKey: FolderSettingsKey,
  items: Array<{ folder?: string }>
) {
  const [storedFolders, setStoredFolders] = useState<string[]>([])

  // Load stored folders from settings on mount
  useEffect(() => {
    settingsApi
      .get(settingsKey)
      .then((row) => {
        if (Array.isArray(row.value)) {
          setStoredFolders(row.value)
        }
      })
      .catch(() => {
        // Setting doesn't exist yet — that's fine
      })
  }, [settingsKey])

  useEffect(() => {
    const handleFoldersUpdated = (event: Event) => {
      const detail = (event as CustomEvent<FoldersUpdatedDetail>).detail
      if (detail?.settingsKey === settingsKey) setStoredFolders(detail.folders)
    }
    window.addEventListener(FOLDERS_UPDATED_EVENT, handleFoldersUpdated)
    return () => window.removeEventListener(FOLDERS_UPDATED_EVENT, handleFoldersUpdated)
  }, [settingsKey])

  const persistFolders = useCallback((next: string[]) => {
    settingsApi.put(settingsKey, next).catch(() => {})
    window.dispatchEvent(new CustomEvent<FoldersUpdatedDetail>(FOLDERS_UPDATED_EVENT, {
      detail: { settingsKey, folders: next },
    }))
  }, [settingsKey])

  // Discover folders from items and merge with stored
  const folders = useMemo(() => {
    const set = new Set<string>(storedFolders)
    for (const item of items) {
      if (item.folder) set.add(item.folder)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [storedFolders, items])

  const createFolder = useCallback(
    (name: string) => {
      setStoredFolders((prev) => {
        if (prev.includes(name)) return prev
        const next = [...prev, name]
        queueMicrotask(() => persistFolders(next))
        return next
      })
    },
    [persistFolders]
  )

  const renameFolder = useCallback(
    (oldName: string, newName: string) => {
      const source = oldName.trim()
      const target = newName.trim()
      if (!source || !target || source === target) return

      setStoredFolders((prev) => {
        const next = prev.filter((f) => f !== source)
        if (!next.includes(target)) next.push(target)
        queueMicrotask(() => persistFolders(next))
        return next
      })
    },
    [persistFolders]
  )

  const deleteFolder = useCallback(
    (name: string) => {
      setStoredFolders((prev) => {
        const next = prev.filter((f) => f !== name)
        queueMicrotask(() => persistFolders(next))
        return next
      })
    },
    [persistFolders]
  )

  return { folders, createFolder, renameFolder, deleteFolder }
}
