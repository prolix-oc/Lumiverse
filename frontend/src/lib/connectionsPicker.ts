import type { ConnectionProfile } from '@/types/api'
import type { ConnectionsPickerVariant, ConnectionProfileTag, SurfaceRectPrefs } from '@/types/store'

export const CONNECTIONS_PICKER_RECTS_STORAGE_KEY = 'lumiverse.connections-picker.rects.v1'

export type ConnectionsPickerVariantRects = Partial<Record<ConnectionsPickerVariant, SurfaceRectPrefs>>

const CONNECTIONS_PICKER_VARIANTS: ConnectionsPickerVariant[] = ['provider-tags', 'split', 'full']

export interface NormalizedConnectionTags {
  profileTags: ConnectionProfileTag[]
  profiles: ConnectionProfile[]
}

export interface ConnectionsPickerRectBounds {
  minWidth: number
  minHeight: number
  maxWidth?: number
  maxHeight?: number
}

export interface ConnectionsPickerAnchorRect {
  left: number
  top: number
  width: number
}

function isSurfaceRectPrefs(value: unknown): value is SurfaceRectPrefs {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => (
    typeof rect[key] === 'number' && Number.isFinite(rect[key])
  ))
}

export function parseConnectionsPickerVariantRects(raw: string | null): ConnectionsPickerVariantRects {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return CONNECTIONS_PICKER_VARIANTS.reduce<ConnectionsPickerVariantRects>((rects, variant) => {
      const rect = (parsed as Record<string, unknown>)[variant]
      if (isSurfaceRectPrefs(rect)) rects[variant] = rect
      return rects
    }, {})
  } catch {
    return {}
  }
}

export function getBalancedModelGridColumns(
  modelCount: number,
  width: number,
  height: number,
  minCellWidth = 140,
  targetRowHeight = 40,
  gap = 4,
): number {
  if (modelCount <= 0) return 1
  const maxColumns = Math.max(1, Math.floor((Math.max(0, width) + gap) / (minCellWidth + gap)))
  const targetRows = Math.max(1, Math.floor((Math.max(0, height) + gap) / (targetRowHeight + gap)))
  return Math.min(maxColumns, Math.max(1, Math.ceil(modelCount / targetRows)))
}

export function getProviderTagsPickerHeight(
  requestedHeight: number,
  searchOpen: boolean,
  showingModels: boolean,
): number {
  if (showingModels) return Math.min(380, Math.max(220, requestedHeight))
  return Math.min(380, 308 + (searchOpen ? 46 : 0))
}

export function resolveConnectionsPickerRect(
  rect: SurfaceRectPrefs,
  bounds: ConnectionsPickerRectBounds,
  viewportWidth: number,
  viewportHeight: number,
  center: boolean,
): SurfaceRectPrefs {
  const maxWidth = Math.min(bounds.maxWidth ?? viewportWidth, viewportWidth)
  const maxHeight = Math.min(bounds.maxHeight ?? viewportHeight, viewportHeight)
  const width = Math.min(Math.max(rect.width, bounds.minWidth), maxWidth)
  const height = Math.min(Math.max(rect.height, bounds.minHeight), maxHeight)
  const x = center
    ? Math.max(0, Math.round((viewportWidth - width) / 2))
    : Math.min(Math.max(rect.x, 0), Math.max(0, viewportWidth - width))
  const y = center
    ? Math.max(0, Math.round((viewportHeight - height) / 2))
    : Math.min(Math.max(rect.y, 0), Math.max(0, viewportHeight - height))
  return { x, y, width, height }
}

export function resolveAnchoredConnectionsPickerRect(
  rect: SurfaceRectPrefs,
  bounds: ConnectionsPickerRectBounds,
  viewportWidth: number,
  viewportHeight: number,
  anchor: ConnectionsPickerAnchorRect,
): SurfaceRectPrefs {
  const clamped = resolveConnectionsPickerRect(
    { ...rect, width: anchor.width },
    bounds,
    viewportWidth,
    viewportHeight,
    false,
  )
  const x = Math.min(
    Math.max(0, Math.round(anchor.left + (anchor.width - clamped.width) / 2)),
    Math.max(0, viewportWidth - clamped.width),
  )
  const y = Math.min(
    Math.max(0, Math.round(anchor.top - clamped.height)),
    Math.max(0, viewportHeight - clamped.height),
  )
  return { ...clamped, x, y }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeTagIds(tagIds: unknown[]): string[] {
  return [...new Set(tagIds.filter(isNonEmptyString).map((id) => id.trim()))]
}

export function getConnectionProfileFavoriteModels(profile: Pick<ConnectionProfile, 'metadata'>): string[] {
  const favoriteModels = profile.metadata?.favoriteModels
  if (!Array.isArray(favoriteModels)) return []
  return normalizeTagIds(favoriteModels)
}

export function setConnectionProfileFavoriteModels(
  profile: ConnectionProfile,
  favoriteModels: string[],
): ConnectionProfile {
  return {
    ...profile,
    metadata: {
      ...(profile.metadata ?? {}),
      favoriteModels: normalizeTagIds(favoriteModels),
    },
  }
}

export function getConnectionProfileTagIds(profile: Pick<ConnectionProfile, 'metadata'>): string[] {
  const tagIds = profile.metadata?.tagIds
  if (!Array.isArray(tagIds)) return []
  return normalizeTagIds(tagIds)
}

export function setConnectionProfileTagIds(profile: ConnectionProfile, tagIds: string[]): ConnectionProfile {
  return {
    ...profile,
    metadata: {
      ...(profile.metadata ?? {}),
      tagIds: normalizeTagIds(tagIds),
    },
  }
}

function makeLegacyTagId(name: string): string {
  return `legacy-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

export function normalizeConnectionProfileTags(
  profiles: ConnectionProfile[],
  profileTags: ConnectionProfileTag[],
): NormalizedConnectionTags {
  const tagMap = new Map(profileTags.map((tag) => [tag.id, tag]))
  const nextProfiles = profiles.map((profile) => {
    const metadata = profile.metadata ?? {}
    const currentTagIds = getConnectionProfileTagIds(profile)
    const legacyTags = Array.isArray(metadata.tags) ? metadata.tags.filter(isNonEmptyString) : []
    const legacyTagIds: string[] = []

    for (const rawName of legacyTags) {
      const name = rawName.trim()
      const id = makeLegacyTagId(name)
      legacyTagIds.push(id)
      if (!tagMap.has(id)) {
        tagMap.set(id, {
          id,
          name,
          color: '#64748B',
          order: tagMap.size,
        })
      }
    }

    const knownIds = new Set(tagMap.keys())
    const tagIds = [...new Set([...currentTagIds, ...legacyTagIds])].filter((id) => knownIds.has(id))
    const { tags: _legacyTags, ...restMetadata } = metadata
    return { ...profile, metadata: { ...restMetadata, tagIds } }
  })

  const nextTags = Array.from(tagMap.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return { profileTags: nextTags, profiles: nextProfiles }
}

export function filterConnectionProfiles(
  profiles: ConnectionProfile[],
  profileTags: ConnectionProfileTag[],
  query: string,
  selectedTagId?: string | null,
  folderFor?: (id: string) => string,
): ConnectionProfile[] {
  const normalizedQuery = query.trim().toLowerCase()
  const tagById = new Map(profileTags.map((tag) => [tag.id, tag]))

  return profiles.filter((profile) => {
    const tagIds = getConnectionProfileTagIds(profile)
    if (selectedTagId && !tagIds.includes(selectedTagId)) return false
    if (!normalizedQuery) return true

    const haystack = [
      profile.name,
      profile.provider,
      profile.model,
      folderFor?.(profile.id),
      ...tagIds.map((id) => tagById.get(id)?.name ?? ''),
    ].join(' ').toLowerCase()

    return haystack.includes(normalizedQuery)
  })
}
