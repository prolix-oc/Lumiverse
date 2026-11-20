/**
 * Book-catalogue search semantics, shared by the full editor's Books pane and
 * the half editor's book picker so the two surfaces cannot drift apart.
 *
 * React-free, store-free and DOM-free on purpose: the sibling `lib/` modules
 * (`lorebookEditorGeometry.ts`, `lorebookEntryColumns.ts`, `quickToolbar*.ts`)
 * follow the same rule so they unit-test under headless `bun test` — importing
 * a component file there crashes on `window is not defined`.
 *
 * The input type is declared locally rather than imported from `@/types/store`
 * or `@/types/api`: this module only ever needs an id, a name and an optional
 * folder, and keeping it structural means any `{ id, name, folder? }`-shaped
 * projection (e.g. `CharacterEditorPage`'s) can reuse it verbatim.
 */

export interface SearchableBook {
  id: string
  name: string
  folder?: string
}

/**
 * The one place a raw query string is normalised. Trimmed so trailing spaces
 * from a paste do not blank the list, lowercased so matching is case-insensitive.
 */
export function normalizeBookQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Fields searched: `name` + `folder`.
 *
 * These are deliberately the same two fields `SearchableSelect` searches when
 * a book is mapped to `{ label: name, sublabel: folder }` — that component
 * filters `label` + `sublabel` only and exposes no predicate prop, so mapping
 * the folder to `sublabel` (as well as `group`, which is never searched) is
 * what keeps the picker and this function in agreement.
 *
 * `needle` must already be normalised via `normalizeBookQuery`.
 */
export function bookMatchesQuery(book: SearchableBook, needle: string): boolean {
  if (!needle) return true
  if (book.name.toLowerCase().includes(needle)) return true
  return (book.folder ?? '').toLowerCase().includes(needle)
}

/**
 * Filters a book list by name + folder. An empty (or whitespace-only) query
 * returns the *input array itself*, not a copy, so callers can keep it inside a
 * `useMemo` without handing React a fresh identity on every keystroke that
 * clears the field.
 */
export function filterBooks<T extends SearchableBook>(books: T[], query: string): T[] {
  const needle = normalizeBookQuery(query)
  if (!needle) return books
  return books.filter((book) => bookMatchesQuery(book, needle))
}
