import { charactersApi } from '@/api/characters'
import { imagesApi, type ImageSize } from '@/api/images'
import { personasApi } from '@/api/personas'

type AvatarEntity = {
  id: string
  image_id?: string | null
  extensions?: { avatar_crop_image_id?: string | null } & Record<string, any>
} | null | undefined

function resolveAvatarUrl(
  id: string | null | undefined,
  imageId: string | null | undefined,
  fallback: (id: string) => string,
  size?: ImageSize
) {
  if (!id) return null
  if (imageId) {
    if (size === 'sm') return imagesApi.smallUrl(imageId)
    if (size === 'lg') return imagesApi.largeUrl(imageId)
    return imagesApi.url(imageId)
  }
  return fallback(id) + (size ? `?size=${size}` : '')
}

/**
 * Square avatar slots show the user-cropped variant when one exists, so the
 * 1:1 frame isn't filled with a letterboxed portrait. The full-aspect original
 * stays on image_id for card exports + portrait/lightbox views.
 */
export function pickCharacterThumbImageId(
  entity: AvatarEntity
): string | null | undefined {
  if (!entity) return null
  const crop = entity.extensions?.avatar_crop_image_id
  if (typeof crop === 'string' && crop) return crop
  return entity.image_id
}

// ---- Full-size variants (lightbox, export) ----

export function getCharacterAvatarUrl(entity: AvatarEntity) {
  return getCharacterAvatarUrlById(entity?.id, entity?.image_id)
}

export function getCharacterAvatarUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl)
}

export function getPersonaAvatarUrl(entity: AvatarEntity) {
  return getPersonaAvatarUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl)
}

export function getActiveAvatarUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.url(overrideImageId)
  return getCharacterAvatarUrl(entity)
}

// ---- Small tier (cards, message bubbles, small UI, ~300px) ----

export function getCharacterAvatarThumbUrl(entity: AvatarEntity) {
  return getCharacterAvatarThumbUrlById(entity?.id, pickCharacterThumbImageId(entity))
}

export function getCharacterAvatarThumbUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl, 'sm')
}

export function getPersonaAvatarThumbUrl(entity: AvatarEntity) {
  return getPersonaAvatarThumbUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarThumbUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl, 'sm')
}

export function getActiveAvatarThumbUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.smallUrl(overrideImageId)
  return getCharacterAvatarThumbUrl(entity)
}

// ---- Large tier (portrait panel, editor preview, ~700px) ----

export function getCharacterAvatarLargeUrl(entity: AvatarEntity) {
  return getCharacterAvatarLargeUrlById(entity?.id, entity?.image_id)
}

export function getCharacterAvatarLargeUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl, 'lg')
}

export function getPersonaAvatarLargeUrl(entity: AvatarEntity) {
  return getPersonaAvatarLargeUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarLargeUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl, 'lg')
}

export function getActiveAvatarLargeUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.largeUrl(overrideImageId)
  return getCharacterAvatarLargeUrl(entity)
}

// ---- Tier matrices (sm / lg / full) for theme overrides ----

/** All three size tiers for one avatar image. `null` when no source resolves. */
export interface AvatarTierUrls {
  /** ~300px */
  sm: string | null
  /** ~700px */
  lg: string | null
  /** Original resolution, no resize. */
  full: string | null
}

function buildTierUrls(
  id: string | null | undefined,
  imageId: string | null | undefined,
  fallback: (id: string) => string,
): AvatarTierUrls {
  return {
    sm: resolveAvatarUrl(id, imageId, fallback, 'sm'),
    lg: resolveAvatarUrl(id, imageId, fallback, 'lg'),
    full: resolveAvatarUrl(id, imageId, fallback),
  }
}

export function getCharacterAvatarTiers(characterId?: string | null, imageId?: string | null): AvatarTierUrls {
  return buildTierUrls(characterId, imageId, charactersApi.avatarUrl)
}

export function getPersonaAvatarTiers(personaId?: string | null, imageId?: string | null): AvatarTierUrls {
  return buildTierUrls(personaId, imageId, personasApi.avatarUrl)
}

/** Tiers for a bare image id (e.g. a chat-specific avatar override). */
export function getImageTiers(imageId?: string | null): AvatarTierUrls {
  if (!imageId) return { sm: null, lg: null, full: null }
  return { sm: imagesApi.smallUrl(imageId), lg: imagesApi.largeUrl(imageId), full: imagesApi.url(imageId) }
}
