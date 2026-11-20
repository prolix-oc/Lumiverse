import type { GroupedRecentChat } from '@/types/api'
import type { LandingPageTab } from '@/lib/landingPageTabs'
import type { LandingVirtualSnapshot } from '@/lib/landingVirtualSnapshot'

export type LandingPageSortField = 'name' | 'recent' | 'created'

export interface LandingPageSnapshot {
  userId: string
  items: GroupedRecentChat[]
  total: number
  scrollTop: number
  requestedTab: LandingPageTab
  searchQuery: string
  sortField: LandingPageSortField
  sortDirection: 'asc' | 'desc'
  pageSize: number
  galleryWidth: 'compact' | 'expanded'
  mainWidth: number
  chatViewportHeight: number
  viewportWidth: number
  viewportHeight: number
  /** Ordered avatar/perspective URLs to predecode during chat -> home. */
  imageUrls?: string[]
  /** Plain measured row sizes; older snapshots fall back to estimates. */
  virtualRows?: LandingVirtualSnapshot
}

// Route transitions unmount the landing page. Keep its light data/UI state in
// memory so returning from a chat can paint the same gallery immediately. The
// browser remains responsible for compressed/decoded image caching; retaining
// DOM nodes or Image objects here would pin substantially more memory.
const SESSION_KEY = '__lumiverse_landing_page_snapshot_v1'
let snapshot: LandingPageSnapshot | null = null
let chatReturnPending = false

function readSessionSnapshot(): LandingPageSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || '') as {
      version?: unknown
      snapshot?: unknown
    }
    if (stored.version !== 1 || !stored.snapshot || typeof stored.snapshot !== 'object') return null
    const candidate = stored.snapshot as Partial<LandingPageSnapshot>
    if (typeof candidate.userId !== 'string' || !Array.isArray(candidate.items)) return null
    return candidate as LandingPageSnapshot
  } catch {
    return null
  }
}

function removeSessionSnapshot(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(SESSION_KEY)
  } catch {}
}

export function readLandingPageSnapshot(userId: string | null | undefined): LandingPageSnapshot | null {
  if (!userId) return null

  // sessionStorage survives a refresh in the chat route but remains scoped to
  // this browser tab. Read it first so it is the authoritative reload seam;
  // memory remains the fallback for restricted-storage environments.
  const stored = readSessionSnapshot()
  if (stored?.userId === userId) {
    snapshot = stored
    // This bridge is only for chat-route reloads. Consuming it here prevents a
    // later refresh of the landing route from replaying a chat-return animation.
    removeSessionSnapshot()
    return stored
  }
  return snapshot?.userId === userId ? snapshot : null
}

export function writeLandingPageSnapshot(next: LandingPageSnapshot): void {
  snapshot = next
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 1, snapshot: next }))
  } catch {
    // Same-tab reload recovery is best-effort; the in-memory fast path remains.
  }
}

/** Read without consuming the one-shot session bridge (used while still in chat). */
export function peekLandingPageSnapshot(): LandingPageSnapshot | null {
  return readSessionSnapshot() ?? snapshot
}

/** One-shot route intent, kept separate from the data snapshot. */
export function markLandingPageChatReturn(): void {
  chatReturnPending = true
}

export function consumeLandingPageChatReturn(): boolean {
  const pending = chatReturnPending
  chatReturnPending = false
  return pending
}

export function clearLandingPageSnapshot(): void {
  snapshot = null
  chatReturnPending = false
  removeSessionSnapshot()
}
