import type {
  CharacterDisplaySettings,
  CharacterFilterTab,
  CharacterSortDirection,
  CharacterSortField,
  CharacterTabDisplaySettings,
  CharacterViewMode,
  HomepageCharacterLibrarySettings,
} from '@/types/store'
import type { CharacterSummary } from '@/types/api'

export interface CharacterBrowserStateForDisplay {
  filterTab: CharacterFilterTab
  sortField: CharacterSortField
  sortDirection: CharacterSortDirection
  viewMode: CharacterViewMode
}

export interface ResolvedCharacterDisplay {
  display: CharacterDisplaySettings
  query: CharacterBrowserStateForDisplay
}

export type CharacterDisplaySurface = 'homepage' | 'characters-tab'

const HOMEPAGE_OWNERSHIP_LABELS = new Set(['mine', 'my character', 'my characters'])

function normalizeHomepageLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function isHomepageOwnershipLabel(value: string | null | undefined): boolean {
  return !!value && HOMEPAGE_OWNERSHIP_LABELS.has(normalizeHomepageLabel(value))
}

export function getHomepageCardMetadata(
  character: Pick<CharacterSummary, 'creator' | 'tags'>,
): { creator: string | null; tags: string[] } {
  const creator = character.creator.trim()
  return {
    creator: creator && !isHomepageOwnershipLabel(creator) ? creator : null,
    tags: character.tags.filter((tag) => !isHomepageOwnershipLabel(tag)),
  }
}

export function getHomepageVisibleTags(
  tags: string[],
  maxVisibleTags: number,
  tagRows: number,
): { visibleTags: string[]; hiddenTagCount: number } {
  if (tagRows <= 0) return { visibleTags: [], hiddenTagCount: tags.length }
  const visibleTags = tags.slice(0, clampInt(maxVisibleTags, 1, 20))
  return {
    visibleTags,
    hiddenTagCount: Math.max(tags.length - visibleTags.length, 0),
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

function getDensityGap(density: CharacterDisplaySettings['density']): number {
  if (density === 'compact') return 10
  if (density === 'large') return 18
  return 14
}

function getFooterHeight(footerMode: CharacterDisplaySettings['footerMode']): number {
  if (footerMode === 'compact') return 52
  if (footerMode === 'spacious') return 92
  return 72
}

function normalizeDisplaySettings(settings: CharacterDisplaySettings): CharacterDisplaySettings {
  const viewMode: CharacterViewMode = ['grid', 'single', 'list'].includes(settings.viewMode) ? settings.viewMode : 'grid'
  const defaultSort: CharacterSortField = ['name', 'recent', 'most_chats', 'created', 'shuffle'].includes(settings.defaultSort) ? settings.defaultSort : 'recent'
  const defaultFilter: CharacterFilterTab = ['characters', 'favorites', 'groups'].includes(settings.defaultFilter) ? settings.defaultFilter : 'characters'
  const density = ['compact', 'balanced', 'large', 'custom'].includes(settings.density) ? settings.density : 'compact'
  const footerMode = ['compact', 'balanced', 'spacious'].includes(settings.footerMode) ? settings.footerMode : 'balanced'

  return {
    ...settings,
    thumbnailWidth: clampInt(settings.thumbnailWidth, 96, 360),
    thumbnailHeight: clampInt(settings.thumbnailHeight, 120, 520),
    density,
    footerMode,
    visibleMetadata: Array.isArray(settings.visibleMetadata) ? settings.visibleMetadata.filter(Boolean) : [],
    tagRows: clampInt(settings.tagRows, 0, 5),
    viewMode,
    defaultSort,
    defaultFilter,
  }
}

function normalizeQuery(query: CharacterBrowserStateForDisplay): CharacterBrowserStateForDisplay {
  let sortField = query.sortField
  const filterTab = query.filterTab
  const viewMode = query.viewMode

  if (filterTab === 'groups' && (sortField === 'shuffle' || sortField === 'most_chats')) {
    sortField = 'recent'
  }

  return {
    filterTab,
    sortField,
    sortDirection: query.sortDirection === 'asc' || query.sortDirection === 'desc' ? query.sortDirection : 'desc',
    viewMode,
  }
}

export function resolveCharacterDisplaySettings(input: {
  surface: CharacterDisplaySurface
  homepageSettings: HomepageCharacterLibrarySettings
  characterTabSettings: CharacterTabDisplaySettings
  currentBrowserState?: Partial<CharacterBrowserStateForDisplay>
}): ResolvedCharacterDisplay {
  const base = input.surface === 'characters-tab' && !input.characterTabSettings.useHomepageSettings
    ? input.characterTabSettings
    : input.homepageSettings
  const display = normalizeDisplaySettings(base)
  const state = input.currentBrowserState ?? {}
  const query = normalizeQuery({
    filterTab: state.filterTab ?? display.defaultFilter,
    sortField: state.sortField ?? display.defaultSort,
    sortDirection: state.sortDirection ?? 'desc',
    viewMode: state.viewMode ?? display.viewMode,
  })

  return { display, query }
}

export function getCharacterGridMetrics(display: CharacterDisplaySettings) {
  const normalized = normalizeDisplaySettings(display)
  const gap = getDensityGap(normalized.density)
  const footerHeight = getFooterHeight(normalized.footerMode)
  return {
    cardMinWidth: normalized.thumbnailWidth,
    imageHeight: normalized.thumbnailHeight,
    footerHeight,
    gap,
    rowHeight: normalized.thumbnailHeight + footerHeight + gap,
  }
}
