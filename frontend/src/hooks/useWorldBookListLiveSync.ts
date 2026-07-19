import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { wsClient, WS_OPEN } from '@/ws/client'
import { EventType } from '@/ws/events'
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
  // Mirror inputs into refs so the subscription binds once and never goes stale.
  const selectedRef = useRef(selectedBookId)
  const setBooksRef = useRef(setBooks)
  const onDeletedRef = useRef(onSelectedBookDeleted)
  const refreshRef = useRef(refreshBooks)
  selectedRef.current = selectedBookId
  setBooksRef.current = setBooks
  onDeletedRef.current = onSelectedBookDeleted
  refreshRef.current = refreshBooks

  const lastLocalEditAt = useRef(0)
  const markLocalBookEdit = useCallback(() => {
    lastLocalEditAt.current = Date.now()
  }, [])

  useEffect(() => {
    const offChanged = wsClient.on(EventType.WORLD_BOOK_CHANGED, (p: WorldBookChangedPayload) => {
      if (!p?.worldBook) return
      // Don't overwrite the metadata fields the user is actively editing — their
      // own debounced save echoes back here, and re-seeding would fight the input.
      if (p.id === selectedRef.current && Date.now() - lastLocalEditAt.current < SELF_EDIT_WINDOW_MS) return
      setBooksRef.current((prev) => upsertById(prev, p.worldBook))
    })
    const offDeleted = wsClient.on(EventType.WORLD_BOOK_DELETED, (p: WorldBookDeletedPayload) => {
      if (!p?.id) return
      setBooksRef.current((prev) => prev.filter((b) => b.id !== p.id))
      if (p.id === selectedRef.current) onDeletedRef.current()
    })
    return () => {
      offChanged()
      offDeleted()
    }
  }, [])

  useEffect(() => {
    if (!refreshRef.current) return
    return wsClient.on(WS_OPEN, () => {
      void refreshRef.current?.()
    })
  }, [])

  return { markLocalBookEdit }
}
