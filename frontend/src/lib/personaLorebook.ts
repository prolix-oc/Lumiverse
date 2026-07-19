/**
 * Build a portable copy of the active persona's attached lorebook for
 * multiplayer relay. A peer's persona lorebook (world book) lives on their OWN
 * instance — the host has no row for it. We export it in `character_book` form
 * (the host's runtime materializer consumes exactly that shape) and ship it so
 * the host's generation can scan/inject it like any other world info.
 *
 * Bounded on the way out so a relay frame can't balloon: cap entry count and
 * total bytes. The host re-validates + re-caps every field as hostile input
 * regardless — this is just to keep the frame small.
 */

import { useStore } from '@/store'
import { worldBooksApi } from '@/api/world-books'

const MAX_ENTRIES = 64
const MAX_BYTES = 200 * 1024

export interface PortableLorebook {
  entries: Array<Record<string, unknown>>
}

/** Returns the active persona's lorebook in portable form, or null if none. */
export async function buildActivePersonaLorebook(): Promise<PortableLorebook | null> {
  const s = useStore.getState()
  const persona = s.personas.find((p) => p.id === s.activePersonaId)
  const bookId = persona?.attached_world_book_id
  if (!persona || !bookId) return null

  try {
    const book = await worldBooksApi.export(bookId, 'character_book')
    const rawEntries = Array.isArray(book?.entries) ? (book.entries as unknown[]) : []
    if (rawEntries.length === 0) return null

    const entries: Array<Record<string, unknown>> = []
    let budget = MAX_BYTES
    for (const e of rawEntries) {
      if (entries.length >= MAX_ENTRIES) break
      if (!e || typeof e !== 'object') continue
      const size = JSON.stringify(e).length
      if (size > budget) break
      budget -= size
      entries.push(e as Record<string, unknown>)
    }
    return entries.length > 0 ? { entries } : null
  } catch {
    return null
  }
}
