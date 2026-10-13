import type { ExtensionInfo } from 'lumiverse-spindle-types'

export type ExtensionSortMode = 'manual' | 'installed' | 'updated' | 'name-asc' | 'name-desc'

export const EXTENSION_SORT_OPTIONS: ReadonlyArray<{ value: ExtensionSortMode; labelKey: string }> = [
  { value: 'manual', labelKey: 'manual' },
  { value: 'installed', labelKey: 'dateInstalled' },
  { value: 'updated', labelKey: 'dateUpdated' },
  { value: 'name-asc', labelKey: 'alphabeticalAsc' },
  { value: 'name-desc', labelKey: 'alphabeticalDesc' },
]

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareNames(left: ExtensionInfo, right: ExtensionInfo): number {
  return nameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id)
}

function normalized(value: unknown): string {
  return typeof value === 'string'
    ? value.toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
}

/**
 * Keeps persisted IDs that still exist, drops stale IDs, and appends newly
 * discovered extensions in the order supplied by the backend.
 */
export function reconcileExtensionOrder(extensions: readonly ExtensionInfo[], persistedOrder: readonly string[]): string[] {
  const available = new Set(extensions.map((extension) => extension.id))
  const seen = new Set<string>()
  const reconciled: string[] = []

  for (const id of persistedOrder) {
    if (!available.has(id) || seen.has(id)) continue
    seen.add(id)
    reconciled.push(id)
  }

  for (const extension of extensions) {
    if (seen.has(extension.id)) continue
    seen.add(extension.id)
    reconciled.push(extension.id)
  }

  return reconciled
}

/** Simple, predictable client-side search across the fields users can see or reason about. */
export function filterExtensions(extensions: readonly ExtensionInfo[], query: string): ExtensionInfo[] {
  const needle = normalized(query)
  if (!needle) return [...extensions]

  return extensions.filter((extension) => {
    const metadata = (extension.metadata as Record<string, unknown> | null) ?? {}
    const searchable = [
      extension.name,
      extension.author,
      extension.description,
      extension.identifier,
      extension.version,
      metadata.branch,
      metadata.install_scope,
      ...extension.permissions,
      ...extension.granted_permissions,
    ]

    return searchable.some((value) => normalized(value).includes(needle))
  })
}

/** Returns a sorted copy without mutating the extensions kept in the store. */
export function sortExtensions(
  extensions: readonly ExtensionInfo[],
  mode: ExtensionSortMode,
  manualOrder: readonly string[] = [],
): ExtensionInfo[] {
  if (mode === 'manual') {
    const reconciled = reconcileExtensionOrder(extensions, manualOrder)
    const rank = new Map(reconciled.map((id, index) => [id, index]))
    return [...extensions].sort((left, right) => {
      const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || compareNames(left, right)
    })
  }

  return [...extensions].sort((left, right) => {
    switch (mode) {
      case 'updated':
        return right.updated_at - left.updated_at || compareNames(left, right)
      case 'name-asc':
        return compareNames(left, right)
      case 'name-desc':
        return -compareNames(left, right)
      case 'installed':
      default:
        return right.installed_at - left.installed_at || compareNames(left, right)
    }
  })
}
