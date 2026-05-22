import { useState, useEffect, useCallback, useMemo } from 'react'
import { settingsApi } from '@/api/settings'

type FolderSettingsKey = 'personaFolders' | 'regexScriptFolders' | 'worldBookFolders'

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
        settingsApi.put(settingsKey, next).catch(() => {})
        return next
      })
    },
    [settingsKey]
  )

  const renameFolder = useCallback(
    (oldName: string, newName: string) => {
      const source = oldName.trim()
      const target = newName.trim()
      if (!source || !target || source === target) return

      setStoredFolders((prev) => {
        const next = prev.filter((f) => f !== source)
        if (!next.includes(target)) next.push(target)
        settingsApi.put(settingsKey, next).catch(() => {})
        return next
      })
    },
    [settingsKey]
  )

  const deleteFolder = useCallback(
    (name: string) => {
      setStoredFolders((prev) => {
        const next = prev.filter((f) => f !== name)
        settingsApi.put(settingsKey, next).catch(() => {})
        return next
      })
    },
    [settingsKey]
  )

  return { folders, createFolder, renameFolder, deleteFolder }
}
