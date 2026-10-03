/**
 * Durable identity and array-preservation rules for extension-backed action
 * preferences (Quick Toolbar `visibleTabIds`/`iconOrder`, composer
 * `order`/`hidden`). Store-, React- and DOM-free: it persists nothing and never
 * decides action eligibility.
 */

export type ExtensionActionKind = 'input' | 'drawer'

/** Owner whose input actions keep the bare contribution key they shipped with. */
export const SUITE_EXTENSION_ID = 'lumiverse_suite'

/**
 * The three first-party Suite input actions that predate stable keys. Re-keying
 * them would drop an existing selection, so the bare ids stay reserved to
 * `SUITE_EXTENSION_ID`; another owner reusing a name gets the namespaced key.
 */
export const SUITE_BARE_INPUT_ACTION_IDS = [
  'lumiverse_suite.lorebook.open_half',
  'lumiverse_suite.lorebook.open_enhanced',
  'lumiverse_suite.connections_picker.open',
] as const

const SUITE_BARE_INPUT_ACTION_ID_SET: ReadonlySet<string> = new Set(SUITE_BARE_INPUT_ACTION_IDS)

/**
 * One live placement. `runtimeId` is the process-local registration/handle id
 * (input action id or drawer tab id); it only backs the ephemeral key used while
 * `contributionId` is unusable, so runtime handles stay distinct without
 * inventing identity.
 */
export interface ExtensionActionRegistration {
  kind: ExtensionActionKind
  extensionId: string
  /** Extension-supplied contribution id; non-string or blank values are unusable. */
  contributionId?: unknown
  /** Process-local registration/handle id. */
  runtimeId: string
}

export interface ExtensionActionIdentity {
  /** Persisted preference key. */
  key: string
  /** Session-scoped: no reload-persistence guarantee. */
  runtime: boolean
}

function isUsableContributionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * `ext-action:` + `JSON.stringify([kind, extensionId, contributionId])`. JSON
 * keeps ids verbatim and makes separators inside ids unambiguous.
 */
export function extensionActionKey(
  kind: ExtensionActionKind,
  extensionId: string,
  contributionId: string,
): string {
  if (kind === 'input' && extensionId === SUITE_EXTENSION_ID && SUITE_BARE_INPUT_ACTION_ID_SET.has(contributionId)) {
    return contributionId
  }
  return `ext-action:${JSON.stringify([kind, extensionId, contributionId])}`
}

/** `ext-runtime:` + the same tuple, with the runtime handle standing in for unusable metadata. */
export function extensionRuntimeKey(
  kind: ExtensionActionKind,
  extensionId: string,
  runtimeId: string,
): string {
  return `ext-runtime:${JSON.stringify([kind, extensionId, runtimeId])}`
}

/** Stable key when the contribution metadata is usable, ephemeral otherwise. */
export function extensionActionIdentity(registration: ExtensionActionRegistration): ExtensionActionIdentity {
  const { kind, extensionId, contributionId, runtimeId } = registration
  if (!isUsableContributionId(contributionId)) {
    return { key: extensionRuntimeKey(kind, extensionId, runtimeId), runtime: true }
  }
  return { key: extensionActionKey(kind, extensionId, contributionId), runtime: false }
}

/** One live registration, keyed and classified. */
export interface ExtensionActionCatalogEntry {
  kind: ExtensionActionKind
  extensionId: string
  /** Verbatim contribution id, or `null` when the metadata was unusable. */
  contributionId: string | null
  runtimeId: string
  key: string
  runtime: boolean
  /**
   * More than one live registration shares this key. The entry is withheld from
   * catalogs and legacy migration until exactly one remains; saved strings,
   * runtime handles and native placements are untouched.
   */
  ambiguous: boolean
}

export interface ExtensionActionCatalog {
  entries: ExtensionActionCatalogEntry[]
}

/** Keys live registrations; duplicate logical tuples are marked `ambiguous`. */
export function buildExtensionActionCatalog(
  registrations: readonly ExtensionActionRegistration[],
): ExtensionActionCatalog {
  const entries: ExtensionActionCatalogEntry[] = registrations.map((registration) => {
    const identity = extensionActionIdentity(registration)
    return {
      kind: registration.kind,
      extensionId: registration.extensionId,
      contributionId: isUsableContributionId(registration.contributionId) ? registration.contributionId : null,
      runtimeId: registration.runtimeId,
      key: identity.key,
      runtime: identity.runtime,
      ambiguous: false,
    }
  })
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  return {
    entries: entries.map((entry) => ({ ...entry, ambiguous: (counts.get(entry.key) ?? 0) > 1 })),
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled extension action kind: ${String(value)}`)
}

/**
 * Positive decimal with no leading zero and nothing trailing. An explicit
 * length-covering scan, not an end-anchored regex, so a trailing newline cannot
 * be absorbed.
 */
function isPositiveDecimalCounter(suffix: string): boolean {
  if (suffix.length === 0) return false
  const first = suffix.charCodeAt(0)
  if (first < 48 || first > 57) return false
  if (first === 48) return false // '0' — a counter never starts with a zero
  for (let index = 1; index < suffix.length; index += 1) {
    const code = suffix.charCodeAt(index)
    if (code < 48 || code > 57) return false
  }
  return true
}

/**
 * Literal legacy prefixes built from the known tuple. Matching by prefix avoids
 * splitting stored ids that legitimately contain `:`.
 */
function legacyPrefixes(entry: ExtensionActionCatalogEntry): string[] {
  if (entry.contributionId === null) return []
  switch (entry.kind) {
    case 'input':
      return [`input-action:${entry.extensionId}:spindle:${entry.extensionId}:action:${entry.contributionId}:`]
    case 'drawer':
      return [`spindle:${entry.extensionId}:tab:${entry.contributionId}:`]
    default:
      return assertNever(entry.kind)
  }
}

/**
 * Canonical key for a stored string: a live key stays itself, a legacy counter
 * key resolves only when exactly one logical tuple matches AND that tuple has
 * exactly one live registration. `null` means preserve the string (unknown,
 * absent or duplicate-withheld).
 */
export function resolveStoredExtensionActionKey(
  stored: string,
  catalog: ExtensionActionCatalog,
): string | null {
  for (const entry of catalog.entries) {
    if (entry.key === stored) return stored
  }
  // Ambiguous entries must still contribute their logical prefix, otherwise a
  // duplicate-withheld owner would be silently discarded and the surviving
  // tuple guessed as unique.
  let matchedKey: string | null = null
  let liveRegistrations = 0
  for (const entry of catalog.entries) {
    if (entry.contributionId === null) continue
    let entryMatches = false
    for (const prefix of legacyPrefixes(entry)) {
      if (!stored.startsWith(prefix)) continue
      if (!isPositiveDecimalCounter(stored.slice(prefix.length))) continue
      entryMatches = true
      break
    }
    if (!entryMatches) continue
    if (matchedKey !== null && matchedKey !== entry.key) return null
    matchedKey = entry.key
    if (!entry.ambiguous) liveRegistrations += 1
  }
  // One matching logical tuple with exactly one live registration; anything else
  // (no match, several tuples, or a duplicated tuple) preserves the string.
  if (matchedKey === null || liveRegistrations !== 1) return null
  return matchedKey
}

function canonicalKeyFor(stored: string, catalog: ExtensionActionCatalog): string {
  return resolveStoredExtensionActionKey(stored, catalog) ?? stored
}

/** Canonicalizes ids and keeps each alias group's first position; non-strings are dropped. */
function dedupeCanonical(ids: readonly string[], catalog: ExtensionActionCatalog): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const key = canonicalKeyFor(id, catalog)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

export interface ToolbarExtensionActionPreferences {
  visibleIds: string[]
  iconOrder: string[]
}

export interface ComposerExtensionActionPreferences {
  order: string[]
  hidden: string[]
}

/**
 * Read-only and idempotent. Selection is the union of an action's aliases at the
 * alias group's first position; the order gains a slot for any selected id
 * without one. `[]` stays empty: it is the defaults sentinel.
 */
export function normalizeToolbarExtensionActions(
  preferences: ToolbarExtensionActionPreferences,
  catalog: ExtensionActionCatalog,
): ToolbarExtensionActionPreferences {
  const visibleIds = dedupeCanonical(preferences.visibleIds, catalog)
  const iconOrder = dedupeCanonical(preferences.iconOrder, catalog)
  const ordered = new Set(iconOrder)
  for (const id of visibleIds) {
    if (ordered.has(id)) continue
    ordered.add(id)
    iconOrder.push(id)
  }
  return { visibleIds, iconOrder }
}

/**
 * Read-only and idempotent. Import is hidden-wins; a hidden id with no order
 * slot gains the tail slot so its hidden intent survives.
 */
export function normalizeComposerExtensionActions(
  preferences: ComposerExtensionActionPreferences,
  catalog: ExtensionActionCatalog,
): ComposerExtensionActionPreferences {
  const order = dedupeCanonical(preferences.order, catalog)
  const hidden = dedupeCanonical(preferences.hidden, catalog)
  const ordered = new Set(order)
  for (const id of hidden) {
    if (ordered.has(id)) continue
    ordered.add(id)
    order.push(id)
  }
  return { order, hidden }
}

/**
 * Hide removes every equivalent visible alias but keeps the complementary order
 * slot; show re-adds one canonical slot.
 */
export function setToolbarExtensionActionVisible(
  preferences: ToolbarExtensionActionPreferences,
  catalog: ExtensionActionCatalog,
  key: string,
  visible: boolean,
): ToolbarExtensionActionPreferences {
  const normalized = normalizeToolbarExtensionActions(preferences, catalog)
  const target = canonicalKeyFor(key, catalog)
  if (!visible) {
    return {
      visibleIds: normalized.visibleIds.filter((id) => id !== target),
      iconOrder: normalized.iconOrder,
    }
  }
  return normalizeToolbarExtensionActions(
    { visibleIds: [...normalized.visibleIds, target], iconOrder: normalized.iconOrder },
    catalog,
  )
}

/**
 * Show removes every equivalent hidden alias; hide writes one canonical hidden
 * entry and keeps the order slot, materializing it when the target had none so
 * the returned pair is already normalized and repeating Hide is a no-op.
 */
export function setComposerExtensionActionVisible(
  preferences: ComposerExtensionActionPreferences,
  catalog: ExtensionActionCatalog,
  key: string,
  visible: boolean,
): ComposerExtensionActionPreferences {
  const normalized = normalizeComposerExtensionActions(preferences, catalog)
  const target = canonicalKeyFor(key, catalog)
  if (!visible) {
    return {
      order: normalized.order.includes(target) ? normalized.order : [...normalized.order, target],
      hidden: normalized.hidden.includes(target) ? normalized.hidden : [...normalized.hidden, target],
    }
  }
  const order = normalized.order.includes(target) ? normalized.order : [...normalized.order, target]
  return { order, hidden: normalized.hidden.filter((id) => id !== target) }
}

/** True only for a unique permutation: duplicated ids are rejected on either side. */
export function isExtensionActionOrderPermutation(
  next: readonly string[],
  current: readonly string[],
): boolean {
  if (next.length !== current.length) return false
  const nextIds = new Set(next)
  const currentIds = new Set(current)
  if (nextIds.size !== next.length || currentIds.size !== current.length) return false
  for (const id of nextIds) {
    if (!currentIds.has(id)) return false
  }
  return true
}

/**
 * Replaces only the slots occupied by `availableIds`, so absent or hidden
 * actions keep their complementary slots. A non-permutation is a stale request
 * and returns the order unchanged; available ids with no slot are appended.
 */
export function mergeExtensionActionOrder(
  fullOrder: readonly string[],
  availableIds: readonly string[],
  nextAvailable: readonly string[],
): string[] {
  const result = [...fullOrder]
  if (!isExtensionActionOrderPermutation(nextAvailable, availableIds)) return result
  const available = new Set(availableIds)
  const queue = [...nextAvailable]
  for (let index = 0; index < result.length && queue.length > 0; index += 1) {
    if (!available.has(result[index])) continue
    result[index] = queue.shift() as string
  }
  for (const id of queue) {
    if (!result.includes(id)) result.push(id)
  }
  return result
}

/** Pin to the first available slot through the same merge; an unavailable target is a no-op. */
export function pinExtensionActionToFirstSlot(
  fullOrder: readonly string[],
  availableIds: readonly string[],
  targetId: string,
): string[] {
  if (!availableIds.includes(targetId)) return [...fullOrder]
  const nextAvailable = [targetId, ...availableIds.filter((id) => id !== targetId)]
  return mergeExtensionActionOrder(fullOrder, availableIds, nextAvailable)
}

/** Composer drag write; a stale permutation is rejected instead of replacing newer state. */
export function applyComposerExtensionActionOrder(
  preferences: ComposerExtensionActionPreferences,
  catalog: ExtensionActionCatalog,
  nextOrder: readonly string[],
): ComposerExtensionActionPreferences {
  const normalized = normalizeComposerExtensionActions(preferences, catalog)
  if (!isExtensionActionOrderPermutation(nextOrder, normalized.order)) return normalized
  return { order: [...nextOrder], hidden: [...normalized.hidden] }
}
