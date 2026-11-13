/**
 * Sparse patch builder for the lorebook editor's bulk "set fields" bar.
 *
 * Only the keys the user actually set are emitted: the server builds its `SET`
 * clause from the keys it receives, so a control left alone is never written.
 * The patch shape comes from the API's own `set_fields` input, so a server-side
 * rename breaks this module at compile time instead of sending a key that the
 * sparse mapper ignores.
 *
 * Dependency-free on purpose: this module is unit-tested directly.
 */

import type { WorldBookEntryBulkSetFieldsInput } from '@/types/api'

export const BULK_UNCHANGED = 'unchanged'

export type BulkTriggerType = 'constant' | 'keyword' | 'vector'
export type BulkTriggerSelection = typeof BULK_UNCHANGED | BulkTriggerType
export type BulkEnabledSelection = typeof BULK_UNCHANGED | 'enabled' | 'disabled'
/** The position select's value: a stringified position, or the sentinel. */
export type BulkPositionSelection = typeof BULK_UNCHANGED | string

/**
 * The authored columns the bulk bar may write. State is `disabled` and Type is
 * the entry's `constant`/`vectorized` pair — the API has neither `enabled` nor
 * `trigger`.
 */
export type BulkFieldPatch = Pick<
  WorldBookEntryBulkSetFieldsInput['fields'],
  'priority' | 'depth' | 'position' | 'disabled' | 'constant' | 'vectorized'
>

export interface BulkFieldForm {
  /** Free-text number input. `''` means untouched. */
  priority: string
  /** Free-text number input. `''` means untouched. */
  depth: string
  position: BulkPositionSelection
  trigger: BulkTriggerSelection
  enabled: BulkEnabledSelection
}

/**
 * The state every control starts in, and the only state in which Apply is a
 * no-op. Exported so the workspace cannot re-introduce a literal default.
 */
export const EMPTY_BULK_FIELD_FORM: BulkFieldForm = {
  priority: '',
  depth: '',
  position: BULK_UNCHANGED,
  trigger: BULK_UNCHANGED,
  enabled: BULK_UNCHANGED,
}

/**
 * Exhaustiveness guard for the selection unions: an unhandled member is a type
 * error, and a value that escaped the type is refused rather than written.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled bulk field selection: ${String(value)}`)
}

/**
 * `null` when the field carries no instruction. `Number('')` is `0`, so the
 * emptiness test has to happen before the coercion; garbage is dropped, not
 * coerced, for the same reason.
 */
function readNumericField(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === BULK_UNCHANGED) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? Math.trunc(value) : null
}

/** Type maps onto the entry's own two flags, as the single-row Type select does. */
function triggerFields(trigger: BulkTriggerType): Pick<BulkFieldPatch, 'constant' | 'vectorized'> {
  switch (trigger) {
    case 'constant':
      return { constant: true, vectorized: false }
    case 'keyword':
      return { constant: false, vectorized: false }
    case 'vector':
      return { constant: false, vectorized: true }
    default:
      return assertNever(trigger)
  }
}

/** Only the fields the user actually set. Never a full patch. */
export function buildBulkFieldPatch(form: BulkFieldForm): BulkFieldPatch {
  const patch: BulkFieldPatch = {}

  const priority = readNumericField(form.priority)
  if (priority !== null) patch.priority = priority

  const depth = readNumericField(form.depth)
  // Mirrors the server's `Math.max(0, ...)`: the UI must not claim a negative
  // depth the column will never hold.
  if (depth !== null) patch.depth = Math.max(0, depth)

  const position = readNumericField(form.position)
  if (position !== null) patch.position = position

  switch (form.trigger) {
    case BULK_UNCHANGED:
      break
    case 'constant':
    case 'keyword':
    case 'vector': {
      const { constant, vectorized } = triggerFields(form.trigger)
      patch.constant = constant
      patch.vectorized = vectorized
      break
    }
    default:
      assertNever(form.trigger)
  }

  switch (form.enabled) {
    case BULK_UNCHANGED:
      break
    case 'enabled':
      patch.disabled = false
      break
    case 'disabled':
      patch.disabled = true
      break
    default:
      assertNever(form.enabled)
  }

  return patch
}

/**
 * False when Apply would send nothing. The server rejects an empty `set_fields`
 * with "At least one field is required", so this gates the button rather than
 * letting the user discover it as an error toast.
 */
export function hasBulkFieldMutation(form: BulkFieldForm): boolean {
  return Object.keys(buildBulkFieldPatch(form)).length > 0
}

/**
 * The one action the bulk bar performs. Apply may only run when it would send a
 * non-empty patch, a book is open, at least one row is selected, no request is
 * in flight, and nothing is waiting on a reconciling reload.
 */
export interface BulkApplyGateInput {
  bookId: string | null
  selectedCount: number
  hasMutation: boolean
  /** True while a prior write is unconfirmed and the entries have not been re-read. */
  noticesReconciliation: boolean
  /** True while a bulk request of this bar is still in flight. */
  pending: boolean
}

/**
 * The inverse is the Apply button's `disabled` state. Keeping the rule in one
 * place is what stops a live Apply while nothing would be sent — including the
 * moment between a resolved request and the reload that has to reconcile it.
 */
export function isBulkApplyEnabled({
  bookId,
  selectedCount,
  hasMutation,
  noticesReconciliation,
  pending,
}: BulkApplyGateInput): boolean {
  return bookId !== null
    && selectedCount > 0
    && hasMutation
    && !noticesReconciliation
    && !pending
}
