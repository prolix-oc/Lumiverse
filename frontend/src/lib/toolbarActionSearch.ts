/**
 * Quick-toolbar icon-list search semantics, plus the reorder rule those lists
 * must use while a search filter is active. Shared by the glued customizer
 * popover (`QuickToolbar.tsx`), the "Visible icons and order" card in
 * `SettingsModal.tsx` and the Customize Toolbar modal
 * (`QuickToolbarCustomizeModal.tsx`) so the three surfaces cannot drift apart.
 *
 * React-free, store-free and DOM-free on purpose: the sibling `lib/` modules
 * (`lorebookBookSearch.ts`, `lorebookEditorGeometry.ts`, `quickToolbar*.ts`)
 * follow the same rule so they unit-test under headless `bun test` — importing
 * a component file there crashes on `window is not defined`.
 *
 * The input type is declared structurally rather than imported: `ToolbarAction`
 * lives in `components/quick-toolbar/useQuickToolbarActions.ts`, which pulls in
 * the store, `react-router` and `window`. A `ToolbarAction` satisfies
 * `SearchableToolbarAction` structurally, so no adapter or mapping is needed at
 * any call site.
 *
 * Why not reuse `lorebookBookSearch.ts`: `SearchableBook` demands a `name`
 * field these actions do not have (they carry `label`) and its predicate
 * searches `folder`. This module copies that module's *shape* and conventions —
 * one normaliser, one predicate, one identity-preserving filter — not its code.
 */

/**
 * Structural mirror of the searchable slice of `ToolbarAction`.
 *
 * `description` is optional so any `{ id, label }`-shaped projection works;
 * `ToolbarAction`'s required `description: string` satisfies it.
 */
export interface SearchableToolbarAction {
  id: string
  label: string
  description?: string
  /**
   * Search-only synonyms, never rendered. Optional so `{ id, label }`-shaped
   * projections still satisfy the type; `ToolbarAction`'s `keywords?: string[]`
   * satisfies it structurally.
   *
   * These are passed straight through from the three registries that already
   * declare them for the command palette (`DrawerTabEntry`, `SettingsTabEntry`,
   * `Command`), so there is no second list to keep in sync. They are what makes
   * `cot` find Reasoning, `png`/`charx` find Characters, `openrouter` find
   * Connections and `reroll` find Regenerate.
   */
  keywords?: string[]
}

/**
 * How `filterActionIds` resolves an id to an action. Accepts the three shapes
 * the call sites already hold, so none of them has to build an adapter:
 *
 * - an action array (`actionCatalog`),
 * - a `Map` keyed by id (`actionById` / `toolbarActionById`),
 * - or a plain resolver function.
 */
export type ToolbarActionSource =
  | SearchableToolbarAction[]
  | ReadonlyMap<string, SearchableToolbarAction>
  | ((id: string) => SearchableToolbarAction | undefined)

/**
 * The one place a raw toolbar query string is normalised. Trimmed so trailing
 * spaces from a paste do not blank the list, lowercased so matching is
 * case-insensitive. Idempotent: normalising an already-normalised query is a
 * no-op.
 */
export function normalizeActionQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Fields searched, in order: `label`, `description`, `keywords`, `id`.
 *
 * Matching is a plain case-insensitive **substring** test on the whole query —
 * not fuzzy, and not an AND over whitespace-separated terms. That is
 * deliberately identical to `SearchableSelect.tsx:115-122` and
 * `bookMatchesQuery` so no two search surfaces in the app answer differently.
 *
 * `id` is searched last, and is the reason this module exists rather than a
 * `filterBooks` call: it lets a user type `settings:`, `command:` or an
 * extension id to bucket the catalog. `keywords` sits ahead of it so a
 * registry-supplied synonym outranks an incidental id substring.
 *
 * Note both fields are searched but only `label` and `description` are ever
 * rendered — `QuickToolbarCustomizeModal.tsx` line-clamps `description` to two
 * lines, which is why synonyms live in `keywords` instead of being appended to
 * the prose.
 *
 * Unlike `bookMatchesQuery`, `query` does **not** have to be pre-normalised:
 * it is normalised here too (the operation is idempotent, and the catalog is
 * ~70 rows, so the cost is irrelevant next to the class of consumer bug it
 * removes). An empty or whitespace-only query matches everything.
 */
export function actionMatchesQuery(action: SearchableToolbarAction, query: string): boolean {
  const needle = normalizeActionQuery(query)
  if (!needle) return true
  if (action.label.toLowerCase().includes(needle)) return true
  if ((action.description ?? '').toLowerCase().includes(needle)) return true
  if (action.keywords?.some((keyword) => keyword.toLowerCase().includes(needle))) return true
  return action.id.toLowerCase().includes(needle)
}

/**
 * Filters an action list by label + description + id, preserving input order.
 *
 * An empty (or whitespace-only) query returns the **input array itself**, not a
 * copy — exactly like `filterBooks`. Consumers rely on that identity to keep a
 * `useMemo` stable across keystrokes that clear the field, so clearing the box
 * does not hand React a fresh array and re-render the whole list.
 */
export function filterActions<T extends SearchableToolbarAction>(actions: T[], query: string): T[] {
  const needle = normalizeActionQuery(query)
  if (!needle) return actions
  return actions.filter((action) => actionMatchesQuery(action, needle))
}

function toResolver(source: ToolbarActionSource): (id: string) => SearchableToolbarAction | undefined {
  if (typeof source === 'function') return source
  if (Array.isArray(source)) {
    // Indexed once per call rather than scanned per id, so a 68-row catalog
    // filtered against a 68-id list stays O(n), not O(n²).
    const byId = new Map<string, SearchableToolbarAction>()
    for (const action of source) {
      if (!byId.has(action.id)) byId.set(action.id, action)
    }
    return (id) => byId.get(id)
  }
  return (id) => source.get(id)
}

/**
 * Same predicate as `filterActions`, over an id list plus a way to resolve those
 * ids — for the call sites that map over ids (`orderedIds`, `catalogOrder`,
 * `toolbarRowIds`) rather than over action objects. Input order is preserved.
 *
 * An empty (or whitespace-only) query returns the **input array itself**, same
 * identity contract as `filterActions`. That is what lets a consumer pass the
 * result straight to `<SortableContext items={...}>` without changing dnd-kit's
 * behaviour when no search is active.
 *
 * An id that resolves to nothing has no text to match, so it is dropped while a
 * query is active and kept while the query is empty (the identity case). Both
 * checklist surfaces already render `null` for unresolvable ids, so this is
 * invisible either way.
 *
 * The canonical consumer call is:
 *   `const filteredEnabledIds = filterActionIds(orderedIds, actionById, query)`
 * — that array is simultaneously the `SortableContext items`, the row-render
 * list, and the `filteredIds` argument to `moveWithinFiltered` /
 * `canMoveWithinFiltered` below.
 */
export function filterActionIds(ids: string[], actions: ToolbarActionSource, query: string): string[] {
  const needle = normalizeActionQuery(query)
  if (!needle) return ids
  const resolve = toResolver(actions)
  return ids.filter((id) => {
    const action = resolve(id)
    return action ? actionMatchesQuery(action, needle) : false
  })
}

/**
 * Resolves the full-list index a move should land on, or `null` when the move is
 * impossible. Shared by `moveWithinFiltered` and `canMoveWithinFiltered` so the
 * chevron's `disabled` state and the chevron's click can never disagree.
 */
function resolveMoveTarget(
  orderedIds: string[],
  filteredIds: string[],
  id: string,
  direction: -1 | 1,
): { from: number; to: number } | null {
  const from = orderedIds.indexOf(id)
  if (from < 0) return null
  const visible = new Set(filteredIds)
  if (!visible.has(id)) return null
  // Visible positions in FULL-list order. Derived from `orderedIds`, not from
  // the order of `filteredIds`, so a caller that hands over an unordered or
  // set-shaped selection still gets the right neighbour.
  const visibleIndices: number[] = []
  for (let index = 0; index < orderedIds.length; index += 1) {
    if (visible.has(orderedIds[index])) visibleIndices.push(index)
  }
  const cursor = visibleIndices.indexOf(from)
  if (cursor < 0) return null
  const neighbour = cursor + direction
  if (neighbour < 0 || neighbour >= visibleIndices.length) return null
  return { from, to: visibleIndices[neighbour] }
}

/**
 * THE reorder-safety primitive, and the whole reason this module is not just a
 * predicate.
 *
 * `orderedIds` is the full stored order (the enabled ids, i.e. what gets written
 * back to `quickToolbarSettings.iconOrder`). `filteredIds` is the subset the
 * user can currently see — normally `filterActionIds(orderedIds, actions, query)`.
 *
 * Returns `orderedIds` with `id` **removed and reinserted at the full-list index
 * of its nearest VISIBLE neighbour** in `direction`, jumping over every hidden
 * id in between so one click always produces exactly one visible step.
 *
 * A pairwise swap — what `useQuickToolbarActions.ts:227-234`'s `moveAction`
 * does — is WRONG under a filter: if the adjacent id in the full list is hidden
 * by the query, the row visibly does not move and the chevron looks dead.
 *
 * With no filter active (`filteredIds` covering every id in `orderedIds`) the
 * nearest visible neighbour *is* the adjacent element, so the result is
 * byte-identical to today's pairwise swap. Adopting this function therefore
 * changes nothing when the search box is empty.
 *
 * Returns `orderedIds` **itself** (same identity) when the move is impossible,
 * so callers can write `if (next === orderedIds) return` and skip the write.
 * A successful move always returns a new array with the same length and the
 * same multiset of ids. The move is impossible when:
 *  - `id` is not in `orderedIds` (e.g. a disabled row — its index is `-1` today
 *    too, which is why both checklist surfaces already disable its chevrons);
 *  - `id` is not in `filteredIds` (it is not visible, so "nearest visible
 *    neighbour" is not a meaningful question — deliberately a no-op, not an
 *    unfiltered move);
 *  - `id` is the first visible id and `direction` is `-1`, or the last visible
 *    id and `direction` is `1`. Note this holds **even when hidden ids sit
 *    beyond it in the full list**: while a filter is active the filtered view is
 *    the whole world, and an item cannot be pushed past rows the user cannot
 *    see.
 *
 * Duplicate ids are treated as corrupt input but handled deterministically:
 * every id is resolved by its FIRST occurrence, and exactly one element is
 * relocated, so the array length and the other copies survive untouched.
 *
 * The splice pair below is `arrayMove` semantics, matching the `arrayMove` that
 * `QuickToolbarCustomizeModal`'s `handleDragEnd` already applies to
 * `orderedIds` — so dragging and chevron-clicking produce the same landing spot.
 */
export function moveWithinFiltered(
  orderedIds: string[],
  filteredIds: string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const target = resolveMoveTarget(orderedIds, filteredIds, id, direction)
  if (!target) return orderedIds
  const next = [...orderedIds]
  next.splice(target.from, 1)
  next.splice(target.to, 0, id)
  return next
}

/**
 * True when `moveWithinFiltered` with the same arguments would actually move
 * something. Drives the chevron `disabled` props, replacing today's
 * `index <= 0` / `index >= orderedIds.length - 1` tests, which are wrong under a
 * filter: they leave a live-looking arrow on the first/last VISIBLE row and
 * disable arrows on rows that can still move.
 *
 * Guaranteed consistent with `moveWithinFiltered` — both go through the same
 * resolver — so `canMoveWithinFiltered(...) === (moveWithinFiltered(...) !== orderedIds)`
 * always holds.
 */
export function canMoveWithinFiltered(
  orderedIds: string[],
  filteredIds: string[],
  id: string,
  direction: -1 | 1,
): boolean {
  return resolveMoveTarget(orderedIds, filteredIds, id, direction) !== null
}
