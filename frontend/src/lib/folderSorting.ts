export interface NamedFolderGroup {
  folder: string
}

/**
 * Keep named folders in a predictable alphabetical order and place the
 * synthetic Uncategorized group after them.
 */
export function compareFolderNames(a: string, b: string): number {
  if (!a) return b ? 1 : 0
  if (!b) return -1
  return a.localeCompare(b)
}

export function sortFolderGroups<T extends NamedFolderGroup>(groups: T[]): T[] {
  return [...groups].sort((a, b) => compareFolderNames(a.folder, b.folder))
}
