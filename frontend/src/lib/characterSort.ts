import type { CharacterSortDirection, CharacterSortField } from '@/types/store'

export type GroupCharacterSortField = Extract<CharacterSortField, 'name' | 'recent' | 'created'>

export const GROUP_CHARACTER_SORT_FIELDS: ReadonlySet<CharacterSortField> = new Set(['name', 'recent', 'created'])

export function isGroupCharacterSortField(sortField: CharacterSortField): sortField is GroupCharacterSortField {
  return GROUP_CHARACTER_SORT_FIELDS.has(sortField)
}

export function resolveGroupCharacterSort(sortField: CharacterSortField): GroupCharacterSortField {
  return isGroupCharacterSortField(sortField) ? sortField : 'recent'
}

export function resolveGroupCharacterSortDirection(
  sortField: CharacterSortField,
  sortDirection: CharacterSortDirection,
): CharacterSortDirection {
  return isGroupCharacterSortField(sortField) ? sortDirection : 'desc'
}
