/**
 * "Which entry should the table scroll to, and can it?"
 *
 * React-free, store-free and DOM-free. The component keeps only the two effects
 * this cannot express — the `querySelector` fast path and the latch write — so
 * the decision itself is testable without a DOM environment.
 *
 * Context: round 3 shipped click-an-entry -> the inspector opens -> the table
 * scrolls to that row, implemented as `querySelector('[data-entry-id=…]')` +
 * `scrollIntoView`. Once the list is virtualized an off-screen row has **no DOM
 * node**, so that query returns `null` and the feature dies silently. The plan
 * below is what replaces the missing node.
 */

/**
 * @remarks
 * - `clear` — nothing is selected. Drop the latch so the next selection reveals.
 * - `skip` — this id was already revealed and is still in the list. Do nothing.
 * - `reveal` — the row is in the filtered list at `index`. Scroll to it and latch.
 * - `filteredOut` — the entry exists in the book but the active search/type
 *   filter excludes it. There is nothing to scroll to, so the caller must say so
 *   instead of doing nothing. **Never latched**: clearing the filter has to be
 *   able to complete the reveal.
 * - `pending` — the id is in neither list. On open the selection arrives one
 *   commit before the entries do, so this is a retry, not a failure. **Never
 *   latched**: latching here is what makes "open onto entry #500" break on a slow
 *   load, permanently, for the rest of the session.
 */
export type EntryRevealPlan =
  | { kind: 'clear' }
  | { kind: 'skip' }
  | { kind: 'reveal'; index: number }
  | { kind: 'filteredOut' }
  | { kind: 'pending' }

/**
 * id -> position, for the list the table actually renders.
 *
 * A `Map` rather than a `.find()` per reveal, mirroring the id->entry index
 * `useTokenCounts` already builds for the same reason: the largest real book is
 * 554 entries and this is consulted from an effect that re-runs on every filter
 * keystroke.
 */
export function buildEntryIndexMap(entries: readonly { id: string }[]): Map<string, number> {
  const index = new Map<string, number>()
  for (let i = 0; i < entries.length; i += 1) index.set(entries[i].id, i)
  return index
}

/**
 * @param selectedEntryId  the entry the inspector has open, if any.
 * @param revealedEntryId  the id this table has already scrolled to (the latch).
 * @param filteredIndexOf  position within the *rendered* list, or `undefined`.
 * @param isKnownEntry     whether the id exists anywhere in the open book.
 */
export function planEntryReveal(
  selectedEntryId: string | null | undefined,
  revealedEntryId: string | null | undefined,
  filteredIndexOf: (entryId: string) => number | undefined,
  isKnownEntry: (entryId: string) => boolean,
): EntryRevealPlan {
  if (!selectedEntryId) return { kind: 'clear' }

  const index = filteredIndexOf(selectedEntryId)
  // `-1` is accepted as "unknown" as well as `undefined`, so a caller that hands
  // in an `indexOf`-shaped lookup cannot accidentally scroll to row -1.
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
    if (revealedEntryId === selectedEntryId) return { kind: 'skip' }
    return { kind: 'reveal', index }
  }

  // Checked *after* the index, and independently of the latch, so that filtering
  // an already-revealed entry out of the list still reports it.
  if (isKnownEntry(selectedEntryId)) return { kind: 'filteredOut' }

  return { kind: 'pending' }
}

/** The two plans that mean "this reveal is finished; stop re-planning it". */
export function revealPlanLatches(plan: EntryRevealPlan): boolean {
  return plan.kind === 'reveal' || plan.kind === 'skip'
}
