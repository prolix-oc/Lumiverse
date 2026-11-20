import { describe, it, expect } from 'bun:test'
import {
  HOMEPAGE_CHARACTER_PAGE_SIZE,
  applyCharacterPage,
  characterQueryKey,
  createCharacterPageState,
  exhaustedCharacterPageState,
  hasMorePages,
  mergeCharacterPage,
  nextPageOffset,
  shouldLoadMore,
} from '../frontend/src/lib/homepageCharacterPaging'
import type { CharacterPageState } from '../frontend/src/lib/homepageCharacterPaging'

interface Row {
  id: string
  name: string
}

function row(id: string, name = id): Row {
  return { id, name }
}

/** A full page of synthetic rows starting at `offset`. */
function page(offset: number, size = HOMEPAGE_CHARACTER_PAGE_SIZE): Row[] {
  return Array.from({ length: size }, (_, index) => row(`c${offset + index}`))
}

/** Fold a response into state the way the hook does. */
function feed(
  state: CharacterPageState<Row>,
  data: readonly Row[],
  total: number,
  generation = state.generation,
): CharacterPageState<Row> {
  return applyCharacterPage(state, {
    generation,
    data,
    total,
    pageSize: HOMEPAGE_CHARACTER_PAGE_SIZE,
  })
}

describe('mergeCharacterPage', () => {
  it('appends the incoming page after the existing rows, in order', () => {
    const merged = mergeCharacterPage([row('a'), row('b')], [row('c'), row('d')])
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops incoming rows whose id is already held', () => {
    const merged = mergeCharacterPage(
      [row('a'), row('b'), row('c')],
      [row('b'), row('d'), row('a'), row('e')],
    )
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps the first occurrence, so the selection fallback target never moves', () => {
    const first = row('a', 'original')
    const merged = mergeCharacterPage([first, row('b')], [row('a', 'from page 2')])
    expect(merged[0]).toBe(first)
    expect(merged[0].name).toBe('original')
    expect(merged).toHaveLength(2)
  })

  it('dedupes within a single incoming page too', () => {
    const merged = mergeCharacterPage([], [row('a'), row('a'), row('b')])
    expect(merged.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('leaves the existing array untouched', () => {
    const existing = [row('a')]
    mergeCharacterPage(existing, [row('b')])
    expect(existing).toHaveLength(1)
  })
})

describe('hasMorePages', () => {
  it('keeps paging while a full page came back and the total is not reached', () => {
    expect(hasMorePages({ loaded: 60, total: 500, lastPageSize: 60, pageSize: 60 })).toBe(true)
  })

  it('stops once loaded reaches total', () => {
    expect(hasMorePages({ loaded: 60, total: 60, lastPageSize: 60, pageSize: 60 })).toBe(false)
    expect(hasMorePages({ loaded: 120, total: 61, lastPageSize: 60, pageSize: 60 })).toBe(false)
  })

  it('stops on a short page even when the total claims there is more', () => {
    expect(hasMorePages({ loaded: 90, total: 5000, lastPageSize: 30, pageSize: 60 })).toBe(false)
  })

  it('stops on an empty page', () => {
    expect(hasMorePages({ loaded: 60, total: 5000, lastPageSize: 0, pageSize: 60 })).toBe(false)
  })

  it('trusts the page size when the total is unknown', () => {
    expect(hasMorePages({ loaded: 60, total: null, lastPageSize: 60, pageSize: 60 })).toBe(true)
    expect(hasMorePages({ loaded: 60, total: undefined, lastPageSize: 60, pageSize: 60 })).toBe(true)
    expect(hasMorePages({ loaded: 60, total: Number.NaN, lastPageSize: 60, pageSize: 60 })).toBe(true)
  })

  it('never claims more pages when the page size is degenerate', () => {
    expect(hasMorePages({ loaded: 0, total: 500, lastPageSize: 0, pageSize: 0 })).toBe(false)
  })
})

describe('applyCharacterPage - accumulation', () => {
  it('accumulates page after page instead of replacing', () => {
    let state = createCharacterPageState<Row>(1)
    state = feed(state, page(0), 180)
    expect(state.characters).toHaveLength(60)
    expect(state.exhausted).toBe(false)

    state = feed(state, page(60), 180)
    expect(state.characters).toHaveLength(120)
    expect(state.characters[0].id).toBe('c0')
    expect(state.characters[119].id).toBe('c119')
    expect(state.exhausted).toBe(false)

    state = feed(state, page(120), 180)
    expect(state.characters).toHaveLength(180)
    expect(state.exhausted).toBe(true)
  })

  it('advances the offset by rows received, not by rows rendered', () => {
    let state = createCharacterPageState<Row>(1)
    state = feed(state, page(0), 500)
    expect(nextPageOffset(state)).toBe(60)

    const overlapping = [...page(0, 10), ...page(60, 50)]
    state = feed(state, overlapping, 500)
    expect(state.characters).toHaveLength(110)
    expect(nextPageOffset(state)).toBe(120)
  })

  it('marks exhausted when loaded reaches the reported total', () => {
    let state = createCharacterPageState<Row>(3)
    state = feed(state, page(0), 120)
    expect(state.exhausted).toBe(false)
    state = feed(state, page(60), 120)
    expect(state.exhausted).toBe(true)
    expect(state.total).toBe(120)
  })

  it('marks exhausted when a short page comes back', () => {
    let state = createCharacterPageState<Row>(1)
    state = feed(state, page(0), 9999)
    expect(state.exhausted).toBe(false)
    state = feed(state, page(60, 12), 9999)
    expect(state.characters).toHaveLength(72)
    expect(state.exhausted).toBe(true)
  })

  it('marks exhausted immediately when the very first page is empty', () => {
    const state = feed(createCharacterPageState<Row>(1), [], 0)
    expect(state.characters).toHaveLength(0)
    expect(state.exhausted).toBe(true)
  })

  it('never reports a total below the rows it is actually holding', () => {
    const state = feed(createCharacterPageState<Row>(1), page(0, 20), 3)
    expect(state.total).toBe(20)
  })
})

describe('applyCharacterPage - stale generation', () => {
  it('drops a response whose generation no longer matches, by identity', () => {
    const orcState = createCharacterPageState<Row>(7)
    const late = applyCharacterPage(orcState, {
      generation: 6,
      data: page(0),
      total: 500,
      pageSize: HOMEPAGE_CHARACTER_PAGE_SIZE,
    })
    expect(late).toBe(orcState)
    expect(late.characters).toHaveLength(0)
    expect(late.received).toBe(0)
  })

  it('drops a late page-2 response that arrives after a reset', () => {
    let state = createCharacterPageState<Row>(1)
    state = feed(state, page(0), 500)
    const inFlightGeneration = state.generation

    const reset = createCharacterPageState<Row>(state.generation + 1)
    const after = applyCharacterPage(reset, {
      generation: inFlightGeneration,
      data: page(60),
      total: 500,
      pageSize: HOMEPAGE_CHARACTER_PAGE_SIZE,
    })
    expect(after).toBe(reset)
    expect(after.characters).toHaveLength(0)
    expect(after.exhausted).toBe(false)
  })

  it('accepts the response once the generation matches again', () => {
    const reset = createCharacterPageState<Row>(2)
    const applied = feed(reset, page(0), 500, 2)
    expect(applied).not.toBe(reset)
    expect(applied.characters).toHaveLength(60)
    expect(applied.generation).toBe(2)
  })
})

describe('shouldLoadMore', () => {
  const loaded = feed(createCharacterPageState<Row>(1), page(0), 500)

  it('arms once a full first page is held', () => {
    expect(shouldLoadMore(loaded, { loading: false, loadingMore: false })).toBe(true)
  })

  it('refuses while the first page of a new query is in flight', () => {
    expect(shouldLoadMore(loaded, { loading: true, loadingMore: false })).toBe(false)
    expect(shouldLoadMore(createCharacterPageState<Row>(2), { loading: false, loadingMore: false }))
      .toBe(false)
  })

  it('refuses while another page is already in flight', () => {
    expect(shouldLoadMore(loaded, { loading: false, loadingMore: true })).toBe(false)
  })

  it('refuses once exhausted', () => {
    const done = feed(loaded, page(60, 3), 500)
    expect(done.exhausted).toBe(true)
    expect(shouldLoadMore(done, { loading: false, loadingMore: false })).toBe(false)
  })

  it('refuses for the this-chat-with-no-chat case', () => {
    const empty = exhaustedCharacterPageState<Row>(4)
    expect(empty.exhausted).toBe(true)
    expect(shouldLoadMore(empty, { loading: false, loadingMore: false })).toBe(false)
  })
})

describe('characterQueryKey', () => {
  const base = {
    search: 'elf',
    tag: 'fantasy',
    sortField: 'recent',
    sortDirection: 'desc',
    filter: 'all',
    chatId: null,
    favoriteIds: ['a', 'b'],
  }

  it('is stable across fresh but equal inputs', () => {
    expect(characterQueryKey({ ...base, favoriteIds: ['a', 'b'] }))
      .toBe(characterQueryKey({ ...base, favoriteIds: ['a', 'b'] }))
  })

  it('changes for every field the request actually sends', () => {
    const original = characterQueryKey(base)
    expect(characterQueryKey({ ...base, search: 'orc' })).not.toBe(original)
    expect(characterQueryKey({ ...base, tag: 'sci-fi' })).not.toBe(original)
    expect(characterQueryKey({ ...base, sortField: 'name' })).not.toBe(original)
    expect(characterQueryKey({ ...base, sortDirection: 'asc' })).not.toBe(original)
    expect(characterQueryKey({ ...base, filter: 'favorites' })).not.toBe(original)
    expect(characterQueryKey({ ...base, chatId: 'chat-1' })).not.toBe(original)
    expect(characterQueryKey({ ...base, favoriteIds: ['a'] })).not.toBe(original)
  })

  it('ignores whitespace the request trims away', () => {
    expect(characterQueryKey({ ...base, search: '  elf  ' })).toBe(characterQueryKey(base))
  })

  it('treats missing, null and empty the same', () => {
    expect(characterQueryKey({})).toBe(characterQueryKey({
      search: '',
      tag: '',
      sortField: '',
      sortDirection: '',
      filter: '',
      chatId: null,
      favoriteIds: null,
    }))
  })

  it('does not collide when a value moves between fields', () => {
    expect(characterQueryKey({ search: 'a', tag: 'b' }))
      .not.toBe(characterQueryKey({ search: 'a-b' }))
  })
})

describe('reset semantics end to end', () => {
  it('a query change discards accumulated pages and starts at offset 0', () => {
    let state = createCharacterPageState<Row>(1)
    state = feed(state, page(0), 500)
    state = feed(state, page(60), 500)
    expect(state.characters).toHaveLength(120)
    expect(nextPageOffset(state)).toBe(120)

    const previousKey = characterQueryKey({ search: 'elf' })
    const nextKey = characterQueryKey({ search: 'orc' })
    expect(nextKey).not.toBe(previousKey)

    const reset = createCharacterPageState<Row>(state.generation + 1)
    expect(reset.characters).toHaveLength(0)
    expect(nextPageOffset(reset)).toBe(0)
    expect(reset.exhausted).toBe(false)
    expect(reset.generation).toBe(2)
  })

  it('an unchanged key means the accumulated pages are kept', () => {
    const key = characterQueryKey({ search: 'elf', favoriteIds: ['a'] })
    expect(characterQueryKey({ search: 'elf', favoriteIds: ['a'] })).toBe(key)
  })
})
