export type ConnectionsOrder = Partial<Record<'llm' | 'imageGen' | 'stt' | 'tts', string[]>>

export type ProfileType = 'llm' | 'imageGen' | 'stt' | 'tts'

export interface OrderableProfile {
  id: string
}

export type OrderedProfiles<T extends OrderableProfile> = T[]

/**
 * Reorder a single slice of profiles to match a persisted order.
 *
 * - Ids listed in the order come first, in the order given.
 * - Profiles missing from the order are appended at the end, preserving
 *   their existing slice order.
 * - Ids in the order that don't resolve to a live profile are dropped.
 *
 * Returns the reordered slice. If `orderedIds` is undefined, returns
 * the original slice (no-op).
 */
export function reorderProfiles<T extends OrderableProfile>(
  slice: readonly T[],
  orderedIds: string[] | undefined,
): T[] {
  if (!orderedIds) return [...slice]
  const byId = new Map(slice.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const reordered: T[] = []
  for (const id of orderedIds) {
    const profile = byId.get(id)
    if (profile && !seen.has(id)) {
      reordered.push(profile)
      seen.add(id)
    }
  }
  for (const profile of slice) {
    if (!seen.has(profile.id)) reordered.push(profile)
  }
  return reordered
}

/**
 * Apply a persisted `connectionsOrder` to the four profile slices. Returns
 * the id arrays that should be passed to the per-type slice mutators. Each
 * entry is undefined when there is no live slice or no order entry.
 */
export function deriveReorderArgs(
  order: ConnectionsOrder,
  slices: Partial<Record<ProfileType, readonly { id: string }[]>>,
): Partial<Record<ProfileType, string[] | undefined>> {
  const out: Partial<Record<ProfileType, string[] | undefined>> = {}
  for (const type of ['llm', 'imageGen', 'stt', 'tts'] as const) {
    const slice = slices[type]
    if (!slice) continue
    const orderedIds = order[type]
    if (!orderedIds) continue
    const reordered = reorderProfiles(slice as readonly { id: string }[], orderedIds)
    out[type] = reordered.map((p) => p.id)
  }
  return out
}