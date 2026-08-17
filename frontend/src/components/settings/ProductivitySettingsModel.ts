export const PRODUCTIVITY_SETTING_KEYS = [
  'quickToolbarSettings',
  'connectionsPickerSettings',
  'loreIndicatorSettings',
  'homepageCharacterLibrarySettings',
  'characterTabDisplaySettings',
  'portraitDockSettings',
  'lorebookEditorSettings',
] as const

export type ProductivitySettingKey = typeof PRODUCTIVITY_SETTING_KEYS[number]

export const PRODUCTIVITY_CONTROL_DEFINITIONS = {
  quickToolbarSettings: ['enabled', 'variant', 'visibleTabIds', 'iconOrder', 'iconSize', 'labelVisible', 'labelTextSize', 'scale', 'orientation', 'rotationDeg', 'opacity', 'snapToEdge', 'rect', 'hideWhenOverlaid', 'fillTopDockWidth', 'showNativeSelectMessages', 'opaqueToolbarBackdrop'],
  connectionsPickerSettings: ['enabled', 'variant', 'launcherEnabled', 'launcherIconSize', 'opacity', 'thumbnailSize', 'density', 'showFavorites', 'showRecent', 'showSearch', 'showModelMetadata', 'profileTags', 'visibleTagIds', 'favoriteProfileIds', 'recentProfileIds', 'rowPadding', 'rowGap', 'sectionSpacing', 'columnWidths'],
  loreIndicatorSettings: ['enabled', 'variant', 'v2ActivationMode', 'v2BookDisplay', 'v5Keybind', 'visibleMetadata', 'iconSize', 'textSize', 'entryTypeAppearance', 'v4Items', 'v4Spacing', 'editorLaunchTarget'],
  homepageCharacterLibrarySettings: ['enabled', 'thumbnailWidth', 'thumbnailHeight', 'density', 'footerMode', 'visibleMetadata', 'tagRows', 'viewMode', 'defaultSort', 'defaultFilter', 'maxVisibleTags', 'showNameBackground', 'panelWidth', 'panelImageHeight', 'panelPinned', 'lastSelectedCharacterId'],
  characterTabDisplaySettings: ['thumbnailWidth', 'thumbnailHeight', 'density', 'footerMode', 'visibleMetadata', 'tagRows', 'viewMode', 'defaultSort', 'defaultFilter', 'useHomepageSettings'],
  portraitDockSettings: ['enabled', 'openAtOriginalSize', 'rememberSizePosition', 'defaultDockSide', 'snapToEdge', 'hoverControls', 'hoverControlSize', 'defaultAspectRatioLock', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'rect', 'pinned', 'aspectRatioLocked', 'dockSide', 'open', 'lastPortrait'],
  lorebookEditorSettings: ['defaultVariant', 'fullEditorLaunchMode', 'triggerDisplay', 'halfButtonEnabled', 'loreIndicatorActionEnabled', 'allowSimultaneousEditors', 'halfEditorMode', 'fullRect', 'halfRect', 'minChatWidth', 'minEditorPaneWidth', 'halfEntriesPaneWidth', 'booksPaneWidth', 'entriesPaneWidth', 'inspectorPaneWidth', 'rowDensity', 'visibleEntryMetadata'],
} as const satisfies Record<ProductivitySettingKey, readonly string[]>

export function reorderItems<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function moveVisibleToolbarItem(
  toolbarIds: readonly string[],
  visibleToolbarIds: readonly string[],
  filteredToolbarIds: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] {
  if (!visibleToolbarIds.includes(id)) return [...toolbarIds]
  const visible = toolbarIds.filter((item) => visibleToolbarIds.includes(item) && filteredToolbarIds.includes(item))
  const index = visible.indexOf(id)
  const target = visible[index + direction]
  if (index < 0 || !target) return [...toolbarIds]
  return reorderItems(toolbarIds, toolbarIds.indexOf(id), toolbarIds.indexOf(target))
}

export function setToolbarItemVisibility(
  toolbarIds: readonly string[],
  visibleToolbarIds: readonly string[],
  id: string,
  visible: boolean,
): string[] {
  if (!toolbarIds.includes(id)) return [...visibleToolbarIds]
  if (visible) return visibleToolbarIds.includes(id) ? [...visibleToolbarIds] : [...visibleToolbarIds, id]
  return visibleToolbarIds.filter((item) => item !== id)
}

/** Single immutable binding point used by the panel before persistKey writes the blob. */
export function bindProductivitySetting(current: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  return { ...current, ...patch }
}

export function parseProductivityNumber(
  raw: string,
  { fallback, min, max, step = 1 }: { fallback: number; min?: number; max?: number; step?: number },
): number {
  const parsed = Number(raw.trim())
  if (!raw.trim() || !Number.isFinite(parsed)) return fallback

  const bounded = Math.min(Number.isFinite(max) ? Number(max) : parsed, Math.max(Number.isFinite(min) ? Number(min) : parsed, parsed))
  if (!Number.isFinite(step) || step <= 0) return bounded

  const origin = Number.isFinite(min) ? Number(min) : 0
  const snapped = origin + Math.round((bounded - origin) / step) * step
  const precision = Math.min(12, Math.max(0, (String(step).split('.')[1]?.length ?? 0) + 3))
  return Number(snapped.toFixed(precision))
}

export function normalizeColor(value: unknown, fallback = '#8b5cf6'): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (/^#[\da-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^#[\da-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((char) => char + char).join('')}`.toUpperCase()
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i)
  if (rgb) {
    const channels = rgb.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Number(channel))))
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  }
  return fallback.toUpperCase()
}

export function previewForSetting(key: ProductivitySettingKey, value: Record<string, any>): Record<string, unknown> {
  switch (key) {
    case 'quickToolbarSettings':
      return { orientation: value.orientation, labelVisible: value.labelVisible, iconOrder: value.iconOrder?.slice(0, 6) ?? [] }
    case 'connectionsPickerSettings':
      return { density: value.density, tags: (value.profileTags ?? []).map((tag: any) => ({ name: tag.name, color: normalizeColor(tag.color) })) }
    case 'loreIndicatorSettings':
      return { variant: value.variant, activation: value.v2ActivationMode, colors: Object.values(value.entryTypeAppearance ?? {}).map((entry: any) => normalizeColor(entry.color)) }
    case 'homepageCharacterLibrarySettings':
      return { width: value.panelWidth, imageHeight: value.panelImageHeight, maxVisibleTags: value.maxVisibleTags }
    case 'characterTabDisplaySettings':
      return { density: value.density, usesHomepage: value.useHomepageSettings }
    case 'portraitDockSettings':
      return { side: value.dockSide, width: value.rect?.width, height: value.rect?.height, pinned: value.pinned }
    case 'lorebookEditorSettings':
      return { variant: value.defaultVariant, halfMode: value.halfEditorMode, density: value.rowDensity }
  }
  return {}
}
