import type { Character } from '@/types/api'
import type { ChatAppearanceAction } from '@/api/chats'

export const PRIMARY_AVATAR_ENTRY_ID = 'primary'
export const AVATAR_BINDING_FIELDS = ['description', 'personality', 'scenario'] as const

export type AvatarBindingField = (typeof AVATAR_BINDING_FIELDS)[number]

export interface AvatarFieldBinding {
  description?: string | null
  personality?: string | null
  scenario?: string | null
  greeting_index?: number | null
}

export type AvatarBindings = Record<string, AvatarFieldBinding>

export interface AlternateAvatarEntry {
  id: string
  image_id: string
  original_image_id?: string
  label: string
}

export function getAlternateAvatars(character?: Character | null): AlternateAvatarEntry[] {
  const raw = character?.extensions?.alternate_avatars
  return Array.isArray(raw) ? raw as AlternateAvatarEntry[] : []
}

export function getAvatarBindings(character?: Character | null): AvatarBindings {
  const raw = character?.extensions?.avatar_bindings
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as AvatarBindings : {}
}

export function setAlternateFieldVariants(
  extensions: Record<string, any>,
  field: AvatarBindingField,
  variants: Array<{ id: string; label: string; content: string }>,
): Record<string, any> {
  const alternateFields = { ...(extensions.alternate_fields || {}) }
  if (variants.length > 0) alternateFields[field] = variants
  else delete alternateFields[field]

  const next = { ...extensions }
  if (Object.keys(alternateFields).length > 0) next.alternate_fields = alternateFields
  else delete next.alternate_fields

  const bindings = extensions.avatar_bindings as AvatarBindings | undefined
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return next
  const validIds = new Set(variants.map((variant) => variant.id))
  let updatedBindings: AvatarBindings | undefined
  for (const [avatarId, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding[field] !== 'string' || validIds.has(binding[field])) continue
    updatedBindings ??= { ...bindings }
    const updatedBinding = { ...binding }
    delete updatedBinding[field]
    if (Object.keys(updatedBinding).length > 0) updatedBindings[avatarId] = updatedBinding
    else delete updatedBindings[avatarId]
  }
  if (updatedBindings) {
    if (Object.keys(updatedBindings).length > 0) next.avatar_bindings = updatedBindings
    else delete next.avatar_bindings
  }
  return next
}

export function getAvatarImageId(character: Character, avatarEntryId: string): string | null | undefined {
  if (avatarEntryId === PRIMARY_AVATAR_ENTRY_ID) return character.image_id || null
  return getAlternateAvatars(character).find((avatar) => avatar.id === avatarEntryId)?.image_id
}

export function findAvatarForField(
  character: Character,
  field: AvatarBindingField,
  variantId: string | null,
): string | null {
  const matches = Object.entries(getAvatarBindings(character))
    .filter(([, binding]) => Object.prototype.hasOwnProperty.call(binding, field) && binding[field] === variantId)
    .map(([avatarId]) => avatarId)
    .filter((avatarId) => getAvatarImageId(character, avatarId) !== undefined)
  return matches.length === 1 ? matches[0] : null
}

export function findAvatarForGreeting(character: Character, greetingIndex: number): string | null {
  const matches = Object.entries(getAvatarBindings(character))
    .filter(([, binding]) => binding.greeting_index === greetingIndex)
    .map(([avatarId]) => avatarId)
    .filter((avatarId) => getAvatarImageId(character, avatarId) !== undefined)
  return matches.length === 1 ? matches[0] : null
}

function setScopedValue(
  metadata: Record<string, any>,
  group: boolean,
  characterId: string,
  soloKey: string,
  groupKey: string,
  value: unknown,
) {
  if (!group) {
    if (value === null || value === undefined) delete metadata[soloKey]
    else metadata[soloKey] = value
    return
  }
  const current = metadata[groupKey] && typeof metadata[groupKey] === 'object'
    ? { ...metadata[groupKey] }
    : {}
  if (value === null || value === undefined) delete current[characterId]
  else current[characterId] = value
  if (Object.keys(current).length > 0) metadata[groupKey] = current
  else delete metadata[groupKey]
}

function getSelections(metadata: Record<string, any>, group: boolean, characterId: string): Record<string, string> {
  const raw = group
    ? metadata.group_alternate_field_selections?.[characterId]
    : metadata.alternate_field_selections
  return raw && typeof raw === 'object' ? { ...raw } : {}
}

function applyAvatarPreview(character: Character, metadata: Record<string, any>, avatarEntryId: string) {
  const group = metadata.group === true
  const characterId = character.id
  const imageId = getAvatarImageId(character, avatarEntryId)
  setScopedValue(metadata, group, characterId, 'active_avatar_id', 'group_active_avatar_ids', avatarEntryId === PRIMARY_AVATAR_ENTRY_ID ? null : imageId)
  setScopedValue(metadata, group, characterId, 'active_avatar_entry_id', 'group_active_avatar_entry_ids', avatarEntryId)

  const binding = getAvatarBindings(character)[avatarEntryId]
  if (!binding) return
  const selections = getSelections(metadata, group, characterId)
  for (const field of AVATAR_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(binding, field)) continue
    if (binding[field] === null) delete selections[field]
    else {
      const variants = character.extensions?.alternate_fields?.[field]
      if (typeof binding[field] === 'string' && Array.isArray(variants)
        && variants.some((variant) => variant?.id === binding[field])) selections[field] = binding[field]!
    }
  }
  setScopedValue(
    metadata,
    group,
    characterId,
    'alternate_field_selections',
    'group_alternate_field_selections',
    Object.keys(selections).length ? selections : null,
  )
  if (Object.prototype.hasOwnProperty.call(binding, 'greeting_index')) {
    setScopedValue(
      metadata,
      group,
      characterId,
      'activeGreetingIndex',
      'group_active_greeting_indices',
      binding.greeting_index ?? 0,
    )
  }
}

export function previewAppearanceMetadata(
  character: Character,
  currentMetadata: Record<string, any> | null,
  action: ChatAppearanceAction,
): Record<string, any> {
  const metadata = { ...(currentMetadata || {}) }
  const group = metadata.group === true
  if (action.type === 'avatar') {
    applyAvatarPreview(character, metadata, action.avatar_entry_id)
  } else if (action.type === 'field') {
    const selections = getSelections(metadata, group, character.id)
    if (action.variant_id === null) delete selections[action.field]
    else selections[action.field] = action.variant_id
    setScopedValue(metadata, group, character.id, 'alternate_field_selections', 'group_alternate_field_selections', Object.keys(selections).length ? selections : null)
    const avatarId = findAvatarForField(character, action.field, action.variant_id)
    if (avatarId) applyAvatarPreview(character, metadata, avatarId)
  } else {
    setScopedValue(metadata, group, character.id, 'activeGreetingIndex', 'group_active_greeting_indices', action.greeting_index)
    const avatarId = findAvatarForGreeting(character, action.greeting_index)
    if (avatarId) applyAvatarPreview(character, metadata, avatarId)
  }
  return metadata
}
