import type {
  CharacterDisplaySettings,
  CharacterTabDisplaySettings,
  ConnectionsPickerSettings,
  HomepageCharacterLibrarySettings,
  LorebookEditorSettings,
  LoreIndicatorSettings,
  PortraitDockSettings,
  QuickToolbarSettings,
  SurfaceRectPrefs,
} from '@/types/store'
import {
  DEFAULT_FULL_EDITOR_RECT,
  DEFAULT_MIN_CHAT_WIDTH,
  DEFAULT_MIN_EDITOR_PANE_WIDTH,
} from '@/lib/lorebookEditorGeometry'

export const DEFAULT_SURFACE_RECT: SurfaceRectPrefs = {
  x: 24,
  y: 24,
  width: 360,
  height: 420,
}

export type QuickToolbarOverlayState = {
  activeModal: unknown
  settingsModalOpen: boolean
  drawerOpen: boolean
  characterEditorOpen: boolean
  lorebookHalfEditorOpen: boolean
  lorebookWorkspaceOpen: boolean
}

export function isQuickToolbarOverlayOpen({
  activeModal,
  settingsModalOpen,
  drawerOpen,
  characterEditorOpen,
  lorebookHalfEditorOpen,
  lorebookWorkspaceOpen,
}: QuickToolbarOverlayState): boolean {
  return Boolean(activeModal)
    || settingsModalOpen
    || drawerOpen
    || characterEditorOpen
    || lorebookHalfEditorOpen
    || lorebookWorkspaceOpen
}

export function quickToolbarOverlayFingerprint({
  activeModal,
  settingsModalOpen,
  drawerOpen,
  characterEditorOpen,
  lorebookHalfEditorOpen,
  lorebookWorkspaceOpen,
}: QuickToolbarOverlayState): string {
  return [
    activeModal ?? '',
    settingsModalOpen ? 'settings' : '',
    drawerOpen ? 'drawer' : '',
    characterEditorOpen ? 'character' : '',
    lorebookHalfEditorOpen ? 'lore-half' : '',
    lorebookWorkspaceOpen ? 'lore-workspace' : '',
  ].join('|')
}

export function shouldHideQuickToolbarWhenOverlaid({
  hideWhenOverlaid,
  isMobile,
  modalRestoreHandle,
  ...overlay
}: QuickToolbarOverlayState & {
  hideWhenOverlaid: boolean | undefined
  isMobile: boolean
  modalRestoreHandle?: boolean
}) {
  return isQuickToolbarOverlayOpen(overlay)
    && ((hideWhenOverlaid ?? isMobile) || modalRestoreHandle === true)
}

export function resolveQuickToolbarOverlayPresentation(
  input: QuickToolbarOverlayState & {
    hideWhenOverlaid: boolean | undefined
    isMobile: boolean
    modalRestoreHandle: boolean
    restoredOverModal: boolean
  },
): 'toolbar' | 'restore-tab' | 'hidden' {
  const overlayOpen = isQuickToolbarOverlayOpen(input)
  if (input.restoredOverModal && overlayOpen) return 'toolbar'
  if (!shouldHideQuickToolbarWhenOverlaid(input)) return 'toolbar'
  if (input.modalRestoreHandle && overlayOpen && !input.restoredOverModal) return 'restore-tab'
  return 'hidden'
}

export function isMobileViewportOrDevice(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth <= 600
}

export type PendingConnectionsDeepLink = {
  target?: string
  provider?: string
  connectionId?: string | null
}

export async function acknowledgePendingConnectionsDeepLink(options: {
  pending: PendingConnectionsDeepLink
  setActiveProfile: (id: string, reason?: 'user_selection') => void
  acknowledgeActive?: (request: { id: string | null; reason: 'user_selection' }) => void | Promise<void>
}): Promise<void> {
  if (options.pending.target !== 'connections' || !options.pending.connectionId) return
  options.setActiveProfile(options.pending.connectionId, 'user_selection')
  await options.acknowledgeActive?.({
    id: options.pending.connectionId,
    reason: 'user_selection',
  })
}

export async function acknowledgeConnectionProfileSelection(options: {
  profileId: string
  setActiveProfile: (id: string | null, reason?: 'user_selection') => void
  acknowledgeActive?: (request: { id: string | null; reason: 'user_selection' }) => void | Promise<void>
  closePopover: () => void
}): Promise<void> {
  options.setActiveProfile(options.profileId, 'user_selection')
  await options.acknowledgeActive?.({ id: options.profileId, reason: 'user_selection' })
  options.closePopover()
}

export const DEFAULT_CHARACTER_DISPLAY_SETTINGS: CharacterDisplaySettings = {
  thumbnailWidth: 170,
  thumbnailHeight: 226,
  density: 'compact',
  footerMode: 'balanced',
  visibleMetadata: ['creator', 'tags'],
  tagRows: 1,
  viewMode: 'grid',
  defaultSort: 'recent',
  defaultFilter: 'characters',
}

export const DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR = '#1C1826'

export function normalizeQuickToolbarBackdropColor(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) return `#${trimmed.slice(1).split('').map((char) => char + char).join('')}`.toUpperCase()
  return DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR
}

export const DEFAULT_QUICK_TOOLBAR_SETTINGS: QuickToolbarSettings & {
  quickToolbarPlacement: 'floating' | 'chat_top_dock'
  autoFitBounds: boolean
  v2IconOnly: boolean
  fillTopDockWidth: boolean
  hideInChatTopDock: boolean
  showNativeSelectMessages: boolean
  showNativeScrollToTop: boolean
  showNativeBrowseMessages: boolean
  opaqueToolbarBackdrop: boolean
  backdropColor: string
} = {
  enabled: true,
  variant: 'v1-free',
  visibleTabIds: [
    'profile',
    'connections',
    'council',
    'lorebook',
    'lumiverse_suite.lorebook.open_half',
    'lumiverse_suite.lorebook.open_enhanced',
    'presets',
    'settings',
  ],
  iconOrder: [
    'profile',
    'connections',
    'council',
    'lorebook',
    'lumiverse_suite.lorebook.open_half',
    'lumiverse_suite.lorebook.open_enhanced',
    'presets',
    'settings',
  ],
  iconSize: 20,
  labelVisible: false,
  labelTextSize: 11,
  scale: 1,
  orientation: 'horizontal',
  rotationDeg: 0,
  opacity: 0.96,
  snapToEdge: true,
  resizeHandlesEnabled: true,
  // `width`/`height` of 0 is the auto sentinel — the toolbar sizes itself from
  // its measured content until the user drags a resize handle. This one carries
  // the *shared* x/y and the *horizontal* extents.
  rect: { x: 328, y: 18, width: 0, height: 0 },
  // The vertical orientation's own extents, so a flip cannot leak the other
  // orientation's box. Auto by default, and position-less on purpose — x/y are
  // shared and live on `rect`. No migration needed: `mergeStoredSetting`
  // backfills this key on every stored row, and auto is the value we want there.
  verticalSize: { width: 0, height: 0 },
  // Must stay 1. `mergeStoredSetting` backfills missing keys from this default,
  // so a value of TOOLBAR_RECT_VERSION would mark every legacy row as already
  // migrated and the repair could never fire.
  rectVersion: 1,
  // Off by default. No migration needed — `mergeStoredSetting` backfills this
  // key on every stored row, and `false` is also the value we want there.
  modalRestoreHandle: false,
  v2IconSize: 28,
  v2LabelTextSize: 11,
  v2LabelVisible: true,
  // The confirmed two-line card design, so an existing row backfilled with this
  // default looks exactly as it did before the setting existed.
  v2Density: 'comfortable',
  quickToolbarPlacement: 'floating',
  autoFitBounds: true,
  v2IconOnly: false,
  fillTopDockWidth: true,
  // Off by default. Dock-chrome hide only — floating placement is unaffected.
  hideInChatTopDock: false,
  showNativeSelectMessages: true,
  showNativeScrollToTop: true,
  showNativeBrowseMessages: true,
  opaqueToolbarBackdrop: false,
  backdropColor: DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR,
  cardWidth: 0,
  cardMinWidth: 0,
  cardMaxWidth: 190,
  cardPadding: 8,
  cardGap: 8,
  // chat-column-relative geometry and are reset once during hydration.
  v2ViewportGeometryVersion: 2,
}

/** Positive adapter for the legacy persisted inverse flag. */
export function keepDockEnabledWhenFloating(settings: Pick<QuickToolbarSettings, 'hideInChatTopDock'> | null | undefined): boolean {
  return settings?.hideInChatTopDock !== true
}

export const DEFAULT_CONNECTIONS_PICKER_SETTINGS: ConnectionsPickerSettings = {
  enabled: true,
  variant: 'provider-tags',
  launcherEnabled: true,
  launcherIconSize: 28,
  opacity: 0.96,
  rect: { x: 0, y: 0, width: 860, height: 300 },
  positionInitialized: false,
  thumbnailSize: 28,
  density: 'compact',
  showFavorites: true,
  showRecent: true,
  showSearch: true,
  showModelMetadata: true,
  profileTags: [],
  visibleTagIds: [],
  favoriteProfileIds: [],
  recentProfileIds: [],
  rowPadding: 8,
  rowGap: 7,
  sectionSpacing: 10,
  columnWidths: { profiles: 180, models: 220 },
  modelLayout: 'grid',
}

export const DEFAULT_LORE_INDICATOR_SETTINGS: LoreIndicatorSettings = {
  enabled: true,
  variant: 'v2-compact',
  v2ActivationMode: 'click',
  v2BookDisplay: 'grouped',
  v5Keybind: 'Ctrl+Shift+L',
  visibleMetadata: ['book', 'type', 'tokens', 'trigger'],
  iconSize: 16,
  textSize: 12,
  entryTypeAppearance: {
    constant: { color: '#F59E0B', icon: 'pin' },
    sticky: { color: '#EC4899', icon: 'clock' },
    keyword: { color: '#3B82F6', icon: 'key' },
    vector: { color: '#8B5CF6', icon: 'search' },
  },
  v4Items: [
    { id: 'active-count', visible: true, removed: false, mode: 'iconText', order: 0 },
    { id: 'token-estimate', visible: true, removed: false, mode: 'iconText', order: 1 },
    { id: 'passes', visible: true, removed: false, mode: 'iconText', order: 2 },
    { id: 'constant', visible: true, removed: false, mode: 'iconText', order: 3 },
    { id: 'keyword', visible: true, removed: false, mode: 'iconText', order: 4 },
    { id: 'vector', visible: true, removed: false, mode: 'iconText', order: 5 },
  ],
  v4Spacing: 8,
  v4GroupBy: 'lorebook',
  v4BookPreviewCount: 4,
  v5ShowShortcutHints: true,
  editorLaunchTarget: 'native',
}

const LORE_APPEARANCE_TYPES = ['constant', 'sticky', 'keyword', 'vector'] as const
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const LORE_ICON = /^[a-z][a-z0-9-]{0,31}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Backfill legacy appearance rows before a Lore view reads their icon or color.
 * The host can switch from an indicator to a populated panel before effects run,
 * so this must be safe to call during render as well as while syncing settings.
 */
export function normalizeLoreIndicatorEntryTypeAppearance(value: unknown): LoreIndicatorSettings['entryTypeAppearance'] {
  const source = isRecord(value) ? value : {}
  const normalized = {} as LoreIndicatorSettings['entryTypeAppearance']
  for (const type of LORE_APPEARANCE_TYPES) {
    const fallback = DEFAULT_LORE_INDICATOR_SETTINGS.entryTypeAppearance[type]
    const appearance = isRecord(source[type]) ? source[type] : {}
    normalized[type] = {
      color: typeof appearance.color === 'string' && HEX_COLOR.test(appearance.color)
        ? appearance.color
        : fallback.color,
      icon: typeof appearance.icon === 'string' && LORE_ICON.test(appearance.icon)
        ? appearance.icon
        : fallback.icon,
    }
  }
  return normalized
}

export const DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS: HomepageCharacterLibrarySettings = {
  ...DEFAULT_CHARACTER_DISPLAY_SETTINGS,
  enabled: true,
  maxVisibleTags: 6,
  showNameBackground: false,
  panelWidth: 420,
  panelImageHeight: 320,
  panelPinned: true,
  lastSelectedCharacterId: null,
}

export const DEFAULT_CHARACTER_TAB_DISPLAY_SETTINGS: CharacterTabDisplaySettings = {
  ...DEFAULT_CHARACTER_DISPLAY_SETTINGS,
  useHomepageSettings: true,
}

export const DEFAULT_PORTRAIT_DOCK_SETTINGS: PortraitDockSettings = {
  enabled: true,
  openAtOriginalSize: true,
  rememberSizePosition: true,
  defaultDockSide: 'right',
  snapToEdge: true,
  hoverControls: true,
  hoverControlSize: 28,
  defaultAspectRatioLock: false,
  minWidth: 180,
  minHeight: 180,
  maxWidth: 720,
  maxHeight: 860,
  rect: { x: 0, y: 0, width: 360, height: 520 },
  pinned: true,
  aspectRatioLocked: false,
  dockSide: 'right',
  open: false,
  lastPortrait: null,
}

export const DEFAULT_LOREBOOK_EDITOR_SETTINGS: LorebookEditorSettings = {
  defaultVariant: 'full',
  fullEditorLaunchMode: 'windowed',
  triggerDisplay: 'words',
  halfButtonEnabled: true,
  loreIndicatorActionEnabled: true,
  allowSimultaneousEditors: true,
  halfEditorMode: 'docked',
  fullRect: { ...DEFAULT_FULL_EDITOR_RECT },
  halfRect: { ...DEFAULT_SURFACE_RECT, width: 720, height: 640 },
  // The chat reservation the half editor clamps against. 420, not the legacy 240:
  // a 240px sliver of chat next to a 1680px editor is the defect, not the fix.
  minChatWidth: DEFAULT_MIN_CHAT_WIDTH,
  minEditorPaneWidth: DEFAULT_MIN_EDITOR_PANE_WIDTH,
  halfEntriesPaneWidth: 390,
  booksPaneWidth: 220,
  // 380, not 320. At 320 the honest column arithmetic
  // (`buildEntryTableMinWidth`) leaves exactly one column standing: `[type,
  // tokens]` needs 324px and misses by four. 380 clears the 374px `[type,
  // priority, tokens]` step, so the full editor opens with three.
  entriesPaneWidth: 380,
  inspectorPaneWidth: 520,
  rowDensity: 'compact',
  visibleEntryMetadata: ['type', 'priority', 'position', 'depth', 'order', 'enabled', 'tokens'],
  tokenCountMode: 'delayed',
  // 500, not the 1000 this shipped with.
  //
  // Since `lib/tokenPrefetchPlan`, this delay no longer gates when the open
  // entry's number *appears* — a fresh open is counted immediately and displayed
  // without writing anything. All it still governs is how long an edit must settle
  // before the count is recomputed and saved back, i.e. it is purely a typing
  // debounce now, and 1000ms is far longer than a typing debounce needs.
  //
  // 500 is not a guess: it is `DEFAULT_ACTIVITY_PAUSE_MS` from
  // `lib/tokenCountScheduler`, which is already this codebase's answer to "how long
  // after a keystroke do we call typing finished" — it is the window the idle sweep
  // parks for after every content change. Using a second, larger number for the
  // same judgement was the only thing justifying 1000. It also stays clear of the
  // 300ms `live` debounce, so the three modes remain ordered.
  //
  // Only affects users who never set the value: `mergeStoredSetting` backfills
  // missing keys from these defaults, and a stored 1000 is not missing.
  tokenCountDelayMs: 500,
  // On by default: it costs at most one request per row the pointer rests on, is
  // never saved, and is the whole "the count is already there when I open the
  // entry" effect. The sweep is off by default because it uploads every entry's
  // text once per session.
  tokenPrefetchHover: true,
  tokenPrefetchHoverDelayMs: 220,
  tokenCountAllEntries: false,
  // 0, not ENTRY_METADATA_VERSION: a stored row that predates this field merges to
  // the default, so the default has to be the pre-migration value.
  entryMetadataVersion: 0,
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export const PRODUCTIVITY_DEFAULTS = freezeDeep({
  quickToolbarSettings: DEFAULT_QUICK_TOOLBAR_SETTINGS,
  connectionsPickerSettings: DEFAULT_CONNECTIONS_PICKER_SETTINGS,
  loreIndicatorSettings: DEFAULT_LORE_INDICATOR_SETTINGS,
  homepageCharacterLibrarySettings: DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS,
  characterTabDisplaySettings: DEFAULT_CHARACTER_TAB_DISPLAY_SETTINGS,
  portraitDockSettings: DEFAULT_PORTRAIT_DOCK_SETTINGS,
  lorebookEditorSettings: DEFAULT_LOREBOOK_EDITOR_SETTINGS,
  showEmbeddingFallbackUi: true,
  showCortexSecondaryUi: true,
  showEditAndSend: true,
  enableToolbarIconReorder: true,
  showComposerCustomizeGear: true,
  productivityTabPosition: 'after-display',
})

export function migrateProductivitySetting(key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = { ...(value as Record<string, unknown>) }
  if (key === 'quickToolbarSettings') {
    if (Object.prototype.hasOwnProperty.call(row, 'backdropColor')) row.backdropColor = normalizeQuickToolbarBackdropColor(row.backdropColor)
    if (row.variant === 'v3-adaptive') row.variant = 'v1-free'
    // V2 floating rows written before the viewport-rail fix commonly contain
    // the old centered chat-column rectangle (for example x=554, width=763).
    // Preserve the user's position, but release the stale width so the current
    // fit code can measure the real viewport. The marker makes this one-shot.
    const rect = row.rect
    if (
      row.variant === 'v2-settings-adjacent'
      && row.v2ViewportGeometryVersion !== 2
      && rect && typeof rect === 'object' && !Array.isArray(rect)
      && Number((rect as Record<string, unknown>).width) > 0
    ) {
      row.rect = { ...(rect as Record<string, unknown>), width: 0, height: 0 }
      row.v2ViewportGeometryVersion = 2
    }
  }
  if (key === 'loreIndicatorSettings') {
    row.entryTypeAppearance = normalizeLoreIndicatorEntryTypeAppearance(row.entryTypeAppearance)
  }
  if (key === 'lorebookEditorSettings' && !row.halfEditorMode) row.halfEditorMode = 'docked'
  return row
}
