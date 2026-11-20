/**
 * Paging arithmetic for the homepage character library's infinite scroll.
 *
 * Deliberately React-free, store-free and DOM-free. The library used to stop dead at the
 * first 60 rows; making it scroll forever means three decisions have to be right every
 * time — *which* rows survive a merge, *when* the server has run out, and *whether* a
 * late response still belongs to the query that is on screen. Those decisions live here,
 * as plain functions over plain data, so they can be tested without a DOM.
 *
 * The hook keeps this state in a ref and mirrors `characters`/`exhausted` into React state
 * for rendering; nothing in this module knows that.
 */

/** The server page size. One request per scroll-to-bottom, 60 rows at a time. */
export const HOMEPAGE_CHARACTER_PAGE_SIZE = 60

/** The only shape this module needs from a character row. */
export interface IdentifiedRow {
  id: string
}

/**
 * Append `incoming` onto `existing`, dropping ids that are already present.
 *
 * `sort: 'discover'` reshuffles server-side per request, so offset paging over it can and
 * does hand back rows that were already in an earlier page. Without this the grid would
 * render duplicate React keys.
 *
 * The FIRST occurrence of an id wins, which is what keeps `characters[0]` — and therefore
 * the hook's selection fallback — stable as pages land.
 */
export function mergeCharacterPage<T extends IdentifiedRow>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const row of existing) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  for (const row of incoming) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  return merged
}

export interface HasMorePagesInput {
  /** Rows the server has handed back so far — *before* dedupe, so it is the next offset. */
  loaded: number
  /** The server's reported row count for this query. Non-finite means "unknown". */
  total: number | null | undefined
  /** How many rows the most recent response actually contained. */
  lastPageSize: number
  pageSize: number
}

/**
 * `loaded` is the pre-dedupe receipt count on purpose. Under `discover` the deduped list
 * can be permanently shorter than `total`, so comparing the *rendered* length against
 * `total` would keep the sentinel armed forever and spin the network.
 */
export function hasMorePages({ loaded, total, lastPageSize, pageSize }: HasMorePagesInput): boolean {
  if (pageSize <= 0) return false
  // A short page is the server saying "that was the tail". Checked before `total` because
  // `total` can legitimately overshoot when rows are filtered out after counting.
  if (lastPageSize < pageSize) return false
  if (typeof total !== 'number' || !Number.isFinite(total)) return true
  return loaded < total
}

export interface CharacterPageState<T extends IdentifiedRow> {
  /** Which query these rows belong to. Bumped on every reset; see `applyCharacterPage`. */
  readonly generation: number
  readonly characters: readonly T[]
  readonly received: number
  readonly total: number
  readonly exhausted: boolean
}

export function createCharacterPageState<T extends IdentifiedRow>(
  generation = 0,
): CharacterPageState<T> {
  return { generation, characters: [], received: 0, total: 0, exhausted: false }
}

/**
 * The terminal state for a query that cannot return anything — today that is `this-chat`
 * with no active chat. `exhausted` keeps the sentinel from ever arming.
 */
export function exhaustedCharacterPageState<T extends IdentifiedRow>(
  generation: number,
): CharacterPageState<T> {
  return { generation, characters: [], received: 0, total: 0, exhausted: true }
}

export interface CharacterPage<T extends IdentifiedRow> {
  /** The generation that was current when the request was *issued*. */
  generation: number
  data: readonly T[]
  total: number
  pageSize?: number
}

/**
 * Fold one server response into the accumulated state.
 *
 * Returns `state` **by identity** when the response is stale — i.e. the search box, tag,
 * sort or filter changed while it was in flight. Callers detect that with `next === state`
 * and drop the response on the floor; appending it would splice rows from the old query
 * into the list the user is now looking at.
 */
export function applyCharacterPage<T extends IdentifiedRow>(
  state: CharacterPageState<T>,
  page: CharacterPage<T>,
): CharacterPageState<T> {
  if (page.generation !== state.generation) return state

  const pageSize = page.pageSize ?? HOMEPAGE_CHARACTER_PAGE_SIZE
  const characters = mergeCharacterPage(state.characters, page.data)
  const received = state.received + page.data.length
  const total = typeof page.total === 'number' && Number.isFinite(page.total)
    ? Math.max(page.total, characters.length)
    : characters.length

  return {
    generation: state.generation,
    characters,
    received,
    total,
    exhausted: !hasMorePages({ loaded: received, total, lastPageSize: page.data.length, pageSize }),
  }
}

/** The offset the next request should ask for. */
export function nextPageOffset<T extends IdentifiedRow>(state: CharacterPageState<T>): number {
  return state.received
}

export interface LoadMoreGuard {
  /** The first page of the current query is still in flight. */
  loading: boolean
  /** A follow-up page is already in flight. */
  loadingMore: boolean
}

/**
 * `received === 0` is the guard that matters least obviously: on reset the state is blank
 * while the previous query's cards are still painted, so an intersection fired in that
 * window would request offset 0 a second time.
 */
export function shouldLoadMore<T extends IdentifiedRow>(
  state: CharacterPageState<T>,
  guard: LoadMoreGuard,
): boolean {
  if (guard.loading || guard.loadingMore) return false
  if (state.exhausted) return false
  if (state.received === 0) return false
  return true
}

export interface CharacterQueryParams {
  search?: string
  tag?: string
  sortField?: string
  sortDirection?: string
  filter?: string
  chatId?: string | null
  favoriteIds?: readonly string[] | string | null
}

/**
 * A stable string identity for "the query the grid is currently paging through".
 *
 * The hook compares this against the previous key to decide whether an effect run is a
 * genuine query change (reset to offset 0, throw away the accumulated pages) or just a
 * new object identity from the store (keep paging). `favorites` in particular arrives as
 * a fresh array on unrelated writes, which would otherwise dump the user back to page 1.
 *
 * `search` is trimmed here so that the key matches the value actually sent to the server.
 */
export function characterQueryKey(params: CharacterQueryParams): string {
  const favorites = Array.isArray(params.favoriteIds)
    ? params.favoriteIds.join(',')
    : params.favoriteIds ?? ''
  return JSON.stringify([
    (params.search ?? '').trim(),
    params.tag ?? '',
    params.sortField ?? '',
    params.sortDirection ?? '',
    params.filter ?? '',
    params.chatId ?? '',
    favorites,
  ])
}
