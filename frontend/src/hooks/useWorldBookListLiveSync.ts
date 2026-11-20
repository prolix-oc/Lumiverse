import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { wsClient, WS_OPEN } from '@/ws/client'
import { EventType } from '@/ws/events'
import { subscribeImportedDataRefresh } from '@/lib/import-data-events'
import { upsertById } from '@/lib/worldBookList'
import type { WorldBookChangedPayload, WorldBookDeletedPayload } from '@/types/ws-events'
import type { WorldBook } from '@/types/api'

/** Ignore WORLD_BOOK_CHANGED echoes of the user's own metadata edits for this long
 *  (measured from the last keystroke) so live-sync doesn't stomp the name/description/
 *  folder field they're typing in. Must exceed the consumer's metadata-save debounce
 *  (the side panel debounces 2s) plus the round-trip before the echo arrives. */
const SELF_EDIT_WINDOW_MS = 4_000

interface Options {
  /** The book whose metadata fields are currently editable, if any. */
  selectedBookId: string | null
  /** Setter for the panel/modal's book list. */
  setBooks: Dispatch<SetStateAction<WorldBook[]>>
  /** Called when the currently-selected book is deleted elsewhere. */
  onSelectedBookDeleted: () => void
  /** Optional hard refresh used to recover from missed WS events after reconnect. */
  refreshBooks?: () => void | Promise<void>
}

/**
 * Keeps a world-book *list* (the sidebar) in sync with backend changes made
 * from another tab/device or by a Spindle extension. Shared by the world-book
 * editor modal and the side panel, which both maintain their own `books` array.
 *
 * Entry-level live-sync lives in WorldBookEntriesSection; this hook only owns the
 * book list + selection. Returns `markLocalBookEdit`, which the consumer calls
 * from its name/description/folder change handlers so the user's own edits don't
 * get clobbered by the echoed event.
 */
export function useWorldBookListLiveSync({
  selectedBookId,
  setBooks,
  onSelectedBookDeleted,
  refreshBooks,
}: Options): { markLocalBookEdit: () => void } {
  const lastLocalEditAt = useRef(0)
  const markLocalBookEdit = useCallback(() => {
    lastLocalEditAt.current = Date.now()
  }, [])

  const onChanged = useEffectEvent((p: WorldBookChangedPayload) => {
    if (!p?.worldBook) return
    // Don't overwrite metadata the user is actively editing when their save
    // echoes back. Effect Events read the latest committed selection/setter.
    if (p.id === selectedBookId && Date.now() - lastLocalEditAt.current < SELF_EDIT_WINDOW_MS) return
    setBooks((prev) => upsertById(prev, p.worldBook))
  })
  const onDeleted = useEffectEvent((p: WorldBookDeletedPayload) => {
    if (!p?.id) return
    setBooks((prev) => prev.filter((b) => b.id !== p.id))
    if (p.id === selectedBookId) onSelectedBookDeleted()
  })
  const onRefresh = useEffectEvent(() => { void refreshBooks?.() })

  useEffect(() => {
    const offChanged = wsClient.on(EventType.WORLD_BOOK_CHANGED, onChanged)
    const offDeleted = wsClient.on(EventType.WORLD_BOOK_DELETED, onDeleted)
    const offLibraryChanged = wsClient.on(EventType.WORLD_BOOK_LIBRARY_CHANGED, onRefresh)
    const offImport = subscribeImportedDataRefresh(onRefresh)
    const offOpen = wsClient.on(WS_OPEN, onRefresh)
    return () => {
      offChanged()
      offDeleted()
      offLibraryChanged()
      offImport()
      offOpen()
    }
  }, [])

  return { markLocalBookEdit }
}
