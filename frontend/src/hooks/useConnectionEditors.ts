import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { connectionRowId, type ConnectionEditorPlacement } from '@/lib/connectionPlacement'

/** Own editor placement, stable recent rows, and focus restoration for one collection. */
export function useConnectionEditors(
  profiles: readonly { id: string }[],
  recentIds: string[],
  expandProfileFolder: (profileId: string) => void,
) {
  const [editors, setEditors] = useState(new Map<string, ConnectionEditorPlacement>())
  const [revealTarget, setRevealTarget] = useState<string | null>(null)
  const entries = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    const ids = new Set(profiles.map(profile => profile.id))
    setEditors(current => {
      const next = new Map([...current].filter(([id]) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [profiles])

  const setEditing = useCallback((id: string, placement: ConnectionEditorPlacement, editing: boolean) => {
    setEditors(current => {
      if (editing ? current.has(id) : current.get(id) !== placement) return current
      const next = new Map(current)
      if (editing) next.set(id, placement)
      else next.delete(id)
      return next
    })
  }, [])

  const focusEntry = useCallback((id: string, placement: ConnectionEditorPlacement) => {
    setRevealTarget(connectionRowId(id, placement))
  }, [])

  const revealEditor = useCallback((id: string, placement: ConnectionEditorPlacement) => {
    if (placement === 'list') expandProfileFolder(id)
    focusEntry(id, placement)
  }, [expandProfileFolder, focusEntry])

  useEffect(() => {
    if (!revealTarget) return
    const entry = entries.current.get(revealTarget)
    entry?.scrollIntoView({ block: 'nearest' })
    const target = entry?.querySelector('input') ?? entry
    target?.focus({ preventScroll: true })
    setRevealTarget(null)
  }, [revealTarget])

  // Selection history can change while a recent row has an unsaved form.
  const editingRecent = [...editors.values()].includes('recent')
  const [recentSnapshot, setRecentSnapshot] = useState(recentIds)
  useEffect(() => {
    if (!editingRecent) setRecentSnapshot(recentIds)
  }, [editingRecent, recentIds])

  const context = useMemo(() => ({ editors, setEditing, revealEditor }), [editors, setEditing, revealEditor])
  const registerEntry = useCallback((id: string, placement: ConnectionEditorPlacement, node: HTMLDivElement | null) => {
    const key = connectionRowId(id, placement)
    if (node) entries.current.set(key, node)
    else entries.current.delete(key)
  }, [])

  return {
    context, registerEntry, focusEntry,
    recentIds: editingRecent ? recentSnapshot : recentIds,
    hasEditor: (id: string) => editors.has(id),
  }
}
