import { createContext, useContext, useState, useCallback } from 'react'
import type { ConnectionEditorPlacement, ConnectionPlacement } from '@/lib/connectionPlacement'

export const ConnectionEditorContext = createContext<{
  editors: ReadonlyMap<string, ConnectionEditorPlacement>
  setEditing: (profileId: string, placement: ConnectionEditorPlacement, editing: boolean) => void
  revealEditor: (profileId: string, placement: ConnectionEditorPlacement) => void
} | null>(null)

/** Track open forms without closing another placement's unsaved editor. */
export function useConnectionEditor(profileId: string, placement: ConnectionPlacement) {
  const context = useContext(ConnectionEditorContext)
  const [localEditing, setLocalEditing] = useState(false)
  const existingEditor = context?.editors.get(profileId)
  const editing = placement !== 'preview' && (context ? existingEditor === placement : localEditing)
  const updateEditing = context?.setEditing
  const revealEditor = context?.revealEditor
  const setEditing = useCallback((value: boolean) => {
    if (placement === 'preview') return
    // Both placements edit the same profile. Return to its existing form
    // instead of opening a second, conflicting copy of its draft.
    if (value && existingEditor && existingEditor !== placement) {
      revealEditor?.(profileId, existingEditor)
      return
    }
    if (updateEditing) updateEditing(profileId, placement, value)
    else setLocalEditing(value)
  }, [profileId, placement, updateEditing, existingEditor, revealEditor])
  return {
    editing, setEditing,
    // A duplicate recent row must not move a connection whose form has a draft.
    dragDisabled: context ? existingEditor !== undefined : localEditing,
  }
}
