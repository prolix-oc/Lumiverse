import type { ExtensionInfo } from 'lumiverse-spindle-types'

export type ExtensionSortMode = 'installed' | 'updated' | 'name-asc' | 'name-desc'

export const EXTENSION_SORT_OPTIONS: ReadonlyArray<{ value: ExtensionSortMode; labelKey: string }> = [
  { value: 'installed', labelKey: 'dateInstalled' },
  { value: 'updated', labelKey: 'dateUpdated' },
  { value: 'name-asc', labelKey: 'alphabeticalAsc' },
  { value: 'name-desc', labelKey: 'alphabeticalDesc' },
]

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareNames(left: ExtensionInfo, right: ExtensionInfo): number {
  return nameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id)
}

/** Returns a sorted copy without mutating the extensions kept in the store. */
export function sortExtensions(extensions: readonly ExtensionInfo[], mode: ExtensionSortMode): ExtensionInfo[] {
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
