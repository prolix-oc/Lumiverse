import type { StateCreator } from 'zustand'
import type { AppStore, SettingsSlice, StartupSettings, ThemeConfig, ReasoningSettings, SettingsWriteSource } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { themeAssetsApi } from '@/api/theme-assets'
import { BASE_URL } from '@/api/client'
import { beginActiveLoomPresetSelection, type PresetSelectionRequest } from '@/lib/loom/preset-selection-coordinator'
import { generateUUID } from '@/lib/uuid'
import { DEFAULT_THEME, normalizeTheme } from '@/theme/presets'
import { PRODUCTIVITY_DEFAULTS, migrateProductivitySetting } from '@/lib/uiProductivityDefaults'
import { createSettingsLoadGenerationGuard } from './settings-load-generation'
import {
  deriveReorderArgs,
  normalizeConnectionsOrder,
  type ConnectionsOrder,
} from './connections-order-merge'

/** Default reasoning settings — used as initial state and for restore-on-unbind. */
export const REASONING_DEFAULTS: ReasoningSettings = {
  prefix: '<think>\n',
  suffix: '\n</think>',
  autoParse: true,
  apiReasoning: false,
  reasoningEffort: 'auto',
  keepInHistory: 0,
  thinkingDisplay: 'auto',
}

/** Keys that represent persisted data (not functions) */
export const DATA_KEYS: ReadonlySet<string> = new Set([
  'landingPageChatsDisplayed',
  'landingPageLayoutMode',
  'landingPageGalleryWidth',
  'landingHiddenCharacterIds',
  'charactersPerPage',
  'personasPerPage',
  'messagesPerPage',
  'chatDisplayMode',
  'longMessageCollapseEnabled',
  'longMessageCollapsePreset',
  'longMessageCollapseCustomHeight',
  'longMessageCollapseDepth',
  'minimalUseFullAvatar',
  'bubbleUserAlign',
  'bubbleDisableHover',
  'bubbleHideAvatarBg',
  'bubbleUseFullAvatar',
  'bubbleOpacity',
  'saveDraftInput',
  'chatWidthMode',
  'chatContentMaxWidth',
  'modalWidthMode',
  'modalMaxWidth',
  'portraitPanelSide',
  'theme',
  'drawerSettings',
  'oocEnabled',
  'lumiaOOCStyle',
  'lumiaOOCInterval',
  'ircUseLeetHandles',
  'chimeraMode',
  'lumiaQuirks',
  'lumiaQuirksEnabled',
  'sovereignHand',
  'contextFilters',
  'activeProfileId',
  'activePersonaId',
  'recentPersonaIds',
  'activeLoomPresetId',
  // Character browser preferences
  'favorites',
  'viewMode',
  'sortField',
  'sortDirection',
  'filterTab',
  'favoritesBarCollapsed',
  // Persona browser preferences
  'personaViewMode',
  'personaSortField',
  'personaSortDirection',
  'personaFilterType',
  // Character-persona bindings
  'characterPersonaBindings',
  'personaTagBindings',
  // Pack browser preferences
  'packFilterTab',
  'packSortField',
  // Active Lumia selections
  'selectedDefinition',
  'selectedChimeraDefinitions',
  'selectedBehaviors',
  'selectedPersonalities',
  // Active Loom selections
  'selectedLoomStyles',
  'selectedLoomUtils',
  'selectedLoomRetrofits',
  // Global world books (always active regardless of character)
  'globalWorldBooks',
  // World info activation settings (budget, scan depth, recursion)
  'worldInfoSettings',
  'worldBookEntryViewPrefs',
  'worldBookListSortDir',
  // Image generation settings
  'imageGeneration',
  // Summarization settings
  'summarization',
  // Wallpaper settings
  'wallpaper',
  'useCharacterBackground',
  // Reasoning / CoT settings
  'reasoningSettings',
  'promptBias',
  'regenFeedback',
  'swipeGesturesEnabled',
  'showMessageTokenCount',
  'messageContextMenuEnabled',
  'suppressContextDropWarnings',
  'guidedGenerations',
  'quickReplySets',
  'toastPosition',
  // Expression display settings
  'expressionDisplay',
  'expressionDetection',
  // Shared sidecar LLM settings
  'sidecarSettings',
  // Image optimization (thumbnail tier sizes)
  'thumbnailSettings',
  // Push notification preferences
  'pushNotificationPreferences',
  // Connection reorder persistence
  'connectionsOrder',
  'customCSS',
  'componentOverrides',
  // Saved theme library (My Themes)
  'savedThemes',
  'chatHeadsEnabled',
  'chatHeadsSize',
  'chatHeadsDirection',
  'chatHeadsOpacity',
  'chatHeadsCompletionSoundEnabled',
  'chatHeadsCustomCompletionSound',
  'spindleSettings',
  'voiceSettings',
  ...Object.keys(PRODUCTIVITY_DEFAULTS),
])

// ── Debounced batch persistence ──────────────────────────────────────────
// Dirty keys accumulate and flush as a single PUT after FLUSH_DELAY ms of
// inactivity.  Also flushes on page unload so nothing is lost.
const FLUSH_DELAY = 1_500
const PENDING_SETTINGS_KEY = '__lumiverse_pending_settings'
const PENDING_IMAGE_GENERATION_PATCH_KEY = '__lumiverse_pending_image_generation_patch'
/**
 * Productivity controls are host-owned canonical settings. The suite reads
 * these namespaced rows only when running against a host that cannot expose
 * the canonical blobs through ctx.settings.core, so keep that compatibility
 * copy in lockstep without making extension storage authoritative.
 */
const PRODUCTIVITY_PRIVATE_FALLBACKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  quickToolbarSettings: ['spindle:lumiverse_suite:quick_toolbar:quickToolbarSettings'],
  connectionsPickerSettings: ['spindle:lumiverse_suite:connections_picker:connectionsPickerSettings'],
  loreIndicatorSettings: ['spindle:lumiverse_suite:lore_indicator:loreIndicatorSettings'],
  homepageCharacterLibrarySettings: [
    'spindle:lumiverse_suite:homepage_library:homepageLibrarySettings',
    'spindle:lumiverse_suite:character_display:homepageSettings',
  ],
  characterTabDisplaySettings: ['spindle:lumiverse_suite:character_display:characterTabSettings'],
  portraitDockSettings: ['spindle:lumiverse_suite:portrait_dock:portraitDockSettings'],
})
const dirtyKeys = new Map<string, any>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushInFlight = false
let activeFlushPromise: Promise<void> | null = null
let activeFlushBatch: Record<string, any> | null = null
let persistenceGeneration = 0
let localSettingsRevision = 0
const localSettingRevisions = new Map<string, number>()
let persistenceScope: string | null = null

/** Per-user, per-device preference; seeded once from the legacy synced row. */
export const DEVICE_ENTER_TO_SEND_STORAGE_KEY = 'lumiverse:device:input-bar-enter-to-send'
const LEGACY_SETTINGS_KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  chatSheldDisplayMode: 'chatDisplayMode',
})
const LEGACY_ENTER_TO_SEND_SETTING_KEY = 'chatSheldEnterToSend'
let lastCommittedSettingsKeys = new Set<string>()
type SettingsTraceData = Record<string, unknown>

function portraitDockTraceSummary(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined
  const rect = isPlainObject(value.rect) ? value.rect : undefined
  return {
    open: value.open,
    dockSide: value.dockSide,
    defaultDockSide: value.defaultDockSide,
    rememberSizePosition: value.rememberSizePosition,
    pinned: value.pinned,
    aspectRatioLocked: value.aspectRatioLocked,
    rect: rect ? {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    } : undefined,
  }
}

function traceSettings(stage: string, data: SettingsTraceData = {}): void {
  void stage
  void data
}

/** Automatic component reconciliation must not dirty provisional settings. */
export function canPersistPortraitDockInitialization(fullSettingsLoaded: boolean): boolean {
  return fullSettingsLoaded
}

function bridgeStorageKey(key: string): string {
  return persistenceScope ? `${key}:${persistenceScope}` : key
}

function deviceEnterToSendStorageKey(): string {
  return bridgeStorageKey(DEVICE_ENTER_TO_SEND_STORAGE_KEY)
}

function readDeviceEnterToSend(): boolean | null {
  try {
    const value = localStorage.getItem(deviceEnterToSendStorageKey())
    if (value === 'true') return true
    if (value === 'false') return false
  } catch {}
  return null
}

function persistDeviceEnterToSend(value: boolean): void {
  try {
    localStorage.setItem(deviceEnterToSendStorageKey(), String(value))
  } catch {
    // The setting remains usable when browser storage is unavailable.
  }
}

/** Select the authenticated user's local persistence bridge. */
export function setSettingsPersistenceScope(userId: string | null): void {
  persistenceScope = userId
}

let settingsSelectionAbort: AbortController | null = null
const settingsLoadGeneration = createSettingsLoadGenerationGuard()

function persistBatch(batch: Record<string, any>): Promise<void> {
  const generation = persistenceGeneration
  flushInFlight = true
  traceSettings('persistBatch:start', {
    generation,
    keys: Object.keys(batch),
    portraitDock: portraitDockTraceSummary(batch.portraitDockSettings),
  })
  const request = settingsApi.putMany(batch).then(() => {
    if (generation === persistenceGeneration) {
      lastCommittedSettingsKeys = new Set(Object.keys(batch))
      clearPendingSettings(batch)
      if (Object.prototype.hasOwnProperty.call(batch, 'imageGeneration')) {
        clearPendingImageGenerationPatch()
      }
      traceSettings('persistBatch:committed', {
        generation,
        keys: Object.keys(batch),
        ownUpdateKeys: [...lastCommittedSettingsKeys],
      })
    }
  }).catch((err) => {
    if (generation !== persistenceGeneration) return
    traceSettings('persistBatch:failed', { generation, keys: Object.keys(batch) })
    console.error('[settings] Batch persist failed, re-queuing:', err)
    // Re-queue failed keys so the next flush retries them.
    for (const [k, v] of Object.entries(batch)) {
      if (!dirtyKeys.has(k)) dirtyKeys.set(k, v)
    }
    scheduleFlush()
    throw err
  }).finally(() => {
    if (generation !== persistenceGeneration) return
    flushInFlight = false
    if (activeFlushPromise === request) {
      activeFlushPromise = null
      activeFlushBatch = null
    }
  })

  activeFlushPromise = request
  activeFlushBatch = batch
  return request
}

function flushDirtyKeys() {
  flushTimer = null
  void flushSettingsNow().catch(() => {})
}

function scheduleFlush() {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushDirtyKeys, FLUSH_DELAY)
}

function hasNewerLocalSetting(key: string, revisionAtLoadStart: number): boolean {
  return (localSettingRevisions.get(key) ?? 0) > revisionAtLoadStart
}

export function persistKey(key: string, value: any, source: SettingsWriteSource = 'unknown') {
  const revision = ++localSettingsRevision
  localSettingRevisions.set(key, revision)
  dirtyKeys.set(key, value)
  const fallbackKeys = PRODUCTIVITY_PRIVATE_FALLBACKS[key] ?? []
  for (const fallbackKey of fallbackKeys) {
    dirtyKeys.set(fallbackKey, value)
  }
  traceSettings('persistKey:queued', {
    key,
    source,
    revision,
    fallbackKeys,
    dirtyKeys: [...dirtyKeys.keys()],
    portraitDock: key === 'portraitDockSettings' ? portraitDockTraceSummary(value) : undefined,
  })
  updatePendingSetting(key, value)
  scheduleFlush()
}

function persistProductivityFallbacks(
  settings: Record<string, unknown>,
  persistedValues: ReadonlyMap<string, unknown>,
): void {
  let queued = false
  for (const [key, value] of Object.entries(settings)) {
    for (const fallbackKey of PRODUCTIVITY_PRIVATE_FALLBACKS[key] ?? []) {
      // A settings reload must be read-only once the compatibility row already
      // matches its canonical source. Re-writing matching rows turns every
      // SETTINGS_UPDATED echo into another reload and persistence cycle.
      const matches = pendingValuesMatch(persistedValues.get(fallbackKey), value)
      traceSettings('compatibility:compare', {
        canonicalKey: key,
        fallbackKey,
        matches,
        action: matches ? 'skip' : 'queue',
        portraitDock: key === 'portraitDockSettings' ? portraitDockTraceSummary(value) : undefined,
      })
      if (matches) continue
      dirtyKeys.set(fallbackKey, value)
      queued = true
    }
  }
  if (queued) scheduleFlush()
}

/**
 * Merge a setting value loaded from storage against the current in-memory
 * default. Recursive so nested keys the stored row is missing (or explicitly
 * null'd) fall back to the default — prevents panels from crashing on
 * `contextFilters.htmlTags.enabled`-style reads when a row was written before
 * a field existed. Arrays and primitives replace the default wholesale.
 */
function isPlainObject(v: any): v is Record<string, any> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function readPendingSettings(): Record<string, any> | null {
  try {
    const raw = localStorage.getItem(bridgeStorageKey(PENDING_SETTINGS_KEY))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readPendingImageGenerationPatch(): Partial<AppStore['imageGeneration']> | null {
  try {
    const raw = localStorage.getItem(bridgeStorageKey(PENDING_IMAGE_GENERATION_PATCH_KEY))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed as Partial<AppStore['imageGeneration']> : null
  } catch {
    return null
  }
}

export function persistPendingImageGenerationPatch(
  patch: Partial<AppStore['imageGeneration']>,
): void {
  const pending = readPendingImageGenerationPatch() ?? {}
  Object.assign(pending, patch)
  try {
    localStorage.setItem(bridgeStorageKey(PENDING_IMAGE_GENERATION_PATCH_KEY), JSON.stringify(pending))
  } catch {}
}

function clearPendingImageGenerationPatch(): void {
  try { localStorage.removeItem(bridgeStorageKey(PENDING_IMAGE_GENERATION_PATCH_KEY)) } catch {}
}

function mergePendingSettings(batch: Record<string, unknown>): boolean {
  const pending = readPendingSettings() ?? {}
  Object.assign(pending, batch)
  try {
    localStorage.setItem(bridgeStorageKey(PENDING_SETTINGS_KEY), JSON.stringify(pending))
  } catch {
    return false
  }
  // A persisted full row is newer than, and incorporates, any partial image bridge.
  if (Object.prototype.hasOwnProperty.call(batch, 'imageGeneration')) {
    clearPendingImageGenerationPatch()
  }
  return true
}

function pendingValuesMatch(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export function hasPendingSetting(key: string): boolean {
  const pending = readPendingSettings()
  return Boolean(pending && Object.prototype.hasOwnProperty.call(pending, key))
}

export function updatePendingSetting(key: string, value: unknown): void {
  const pending = readPendingSettings()
  if (!pending || !Object.prototype.hasOwnProperty.call(pending, key)) return
  pending[key] = value
  try {
    localStorage.setItem(bridgeStorageKey(PENDING_SETTINGS_KEY), JSON.stringify(pending))
  } catch {}
}

export function clearPendingSettings(persisted: Record<string, unknown>): void {
  const pending = readPendingSettings()
  if (!pending) return

  let changed = false
  for (const [key, value] of Object.entries(persisted)) {
    if (
      Object.prototype.hasOwnProperty.call(pending, key)
      && pendingValuesMatch(pending[key], value)
    ) {
      delete pending[key]
      changed = true
    }
  }
  if (!changed) return

  try {
    if (Object.keys(pending).length === 0) {
      localStorage.removeItem(bridgeStorageKey(PENDING_SETTINGS_KEY))
    } else {
      localStorage.setItem(bridgeStorageKey(PENDING_SETTINGS_KEY), JSON.stringify(pending))
    }
  } catch {}
}

function mergeStoredSetting(defaultValue: any, storedValue: any): any {
  if (!isPlainObject(defaultValue)) return storedValue
  if (!isPlainObject(storedValue)) return defaultValue
  const merged: Record<string, any> = { ...defaultValue }
  for (const key of Object.keys(storedValue)) {
    merged[key] = mergeStoredSetting(defaultValue[key], storedValue[key])
  }
  return merged
}

export function migrateStoredImageGeneration(storedValue: any): any {
  if (
    isPlainObject(storedValue)
    && typeof storedValue.includeCharacters === 'boolean'
    && typeof storedValue.includePersona !== 'boolean'
  ) {
    return { ...storedValue, includePersona: storedValue.includeCharacters }
  }
  return storedValue
}

/** Immediately flush any pending settings (e.g. on page unload). */
export function flushSettings() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const batch = Object.fromEntries(dirtyKeys)
  dirtyKeys.clear()
  const bridgeBatch = {
    ...(activeFlushBatch ?? {}),
    ...batch,
  }

  // Merge with any deferred bridge values so an unrelated unload cannot erase
  // settings that still need a later hydration pass.
  if (Object.keys(bridgeBatch).length > 0) {
    mergePendingSettings(bridgeBatch)
  }
  if (Object.keys(batch).length === 0) return

  // keepalive fetch survives page unload and supports PUT (unlike sendBeacon)
  fetch(`${BASE_URL}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => {})
}

/** Immediately persist all dirty settings and wait for the server commit. */
export function flushSettingsNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (flushInFlight && activeFlushPromise) {
    return activeFlushPromise.catch(() => {}).then(() => flushSettingsNow())
  }


  if (dirtyKeys.size === 0) {
    return activeFlushPromise ?? Promise.resolve()
  }

  const batch = Object.fromEntries(dirtyKeys)
  dirtyKeys.clear()
  return persistBatch(batch)
}

/** True when a flush is in flight or dirty keys are pending. */
export function hasUnsavedSettings(): boolean {
  return dirtyKeys.size > 0 || flushInFlight || activeFlushPromise !== null
}

export function consumeOwnSettingsUpdate(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const event = payload as { key?: unknown; keys?: unknown }
  const keys = typeof event.key === 'string'
    ? [event.key]
    : Array.isArray(event.keys) && event.keys.every((key): key is string => typeof key === 'string')
      ? event.keys
      : []
  if (keys.length === 0 || !keys.every(key => lastCommittedSettingsKeys.has(key))) return false
  for (const key of keys) lastCommittedSettingsKeys.delete(key)
  return true
}

/** Whether a SETTINGS_UPDATED event requires a settings reload in this tab. */
export function shouldReloadSettingsAfterUpdate(payload: unknown): boolean {
  const unsaved = hasUnsavedSettings()
  const ownUpdate = consumeOwnSettingsUpdate(payload)
  const reload = !unsaved && !ownUpdate
  traceSettings('serverUpdate:decision', {
    keys: settingsUpdateKeys(payload),
    unsaved,
    ownUpdate,
    reload,
    dirtyKeys: [...dirtyKeys.keys()],
    flushInFlight,
    ownUpdateKeysRemaining: [...lastCommittedSettingsKeys],
  })
  return reload
}

export function settingsUpdateKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const event = payload as { key?: unknown; keys?: unknown }
  if (typeof event.key === 'string') return [event.key]
  return Array.isArray(event.keys) && event.keys.every((key): key is string => typeof key === 'string')
    ? [...event.keys]
    : []
}

/**
 * Remove a direct-write's matching dirty value without discarding a newer
 * debounced edit that was queued while the request was in flight.
 */
export function clearDirtyKey(key: string, persistedValue?: unknown): void {
  if (arguments.length === 1 || pendingValuesMatch(dirtyKeys.get(key), persistedValue)) {
    dirtyKeys.delete(key)
  }
}

/** Preserve one user's unsaved settings before changing authentication scope. */
export function resetSettingsPersistence(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (persistenceScope) {
    const preserved = {
      ...(activeFlushBatch ?? {}),
      ...Object.fromEntries(dirtyKeys),
    }
    if (Object.keys(preserved).length > 0) {
      mergePendingSettings(preserved)
    }
  } else {
    try {
      localStorage.removeItem(PENDING_SETTINGS_KEY)
      localStorage.removeItem(PENDING_IMAGE_GENERATION_PATCH_KEY)
    } catch {}
  }
  persistenceGeneration += 1
  settingsLoadGeneration.begin()
  dirtyKeys.clear()
  flushInFlight = false
  activeFlushPromise = null
  activeFlushBatch = null
  lastCommittedSettingsKeys.clear()
  persistenceScope = null
}

// Flush on page unload so slider drags / rapid changes are never lost
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSettings)
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settingsLoaded: false,
  fullSettingsLoaded: false,
  landingPageChatsDisplayed: 12,
  landingPageLayoutMode: 'cards',
  landingPageGalleryWidth: 'compact',
  landingHiddenCharacterIds: [],
  charactersPerPage: 50,
  personasPerPage: 24,
  messagesPerPage: 50,
  chatDisplayMode: 'minimal',
  longMessageCollapseEnabled: false,
  longMessageCollapsePreset: 'comfortable',
  longMessageCollapseCustomHeight: 500,
  longMessageCollapseDepth: 0,
  minimalUseFullAvatar: false,
  bubbleUserAlign: 'right',
  bubbleDisableHover: false,
  bubbleHideAvatarBg: false,
  bubbleUseFullAvatar: false,
  bubbleOpacity: 1,
  inputBarEnterToSend: true,
  saveDraftInput: false,
  chatWidthMode: 'full',
  chatContentMaxWidth: 900,
  modalWidthMode: 'full',
  modalMaxWidth: 900,
  portraitPanelSide: 'right',
  theme: null,
  characterThemeOverlay: null,
  drawerSettings: {
    side: 'right',
    verticalPosition: 15,
    tabSize: 'large',
    panelWidthMode: 'default',
    customPanelWidth: 35,
    showTabLabels: true,
    hiddenTabIds: [],
    tabOrder: [],
  },
  oocEnabled: true,
  lumiaOOCStyle: 'social',
  lumiaOOCInterval: null,
  ircUseLeetHandles: true,
  chimeraMode: false,
  lumiaQuirks: '',
  lumiaQuirksEnabled: true,
  sovereignHand: {
    enabled: false,
    excludeLastMessage: true,
    includeMessageInPrompt: true,
  },
  contextFilters: {
    htmlTags: { enabled: false, keepDepth: 3, stripFonts: false, fontKeepDepth: 3 },
    detailsBlocks: { enabled: false, keepDepth: 3, keepOnly: false },
    loomItems: { enabled: false, keepDepth: 5, keepOnly: false },
  },
  reasoningSettings: { ...REASONING_DEFAULTS },
  regenFeedback: {
    enabled: false,
    position: 'user',
    includePreviousGeneration: false,
    format: '[OOC: {{$regenInput}}]',
  },
  swipeGesturesEnabled: true,
  showMessageTokenCount: true,
  messageContextMenuEnabled: true,
  suppressContextDropWarnings: false,
  favoritesBarCollapsed: false,
  globalWorldBooks: [],
  worldInfoSettings: {
    forceCaseSensitive: false,
    forceMatchWholeWords: false,
    globalScanDepth: null,
    maxRecursionPasses: 3,
    maxActivatedEntries: 0,
    maxTokenBudget: 0,
    minPriority: 0,
  },
  worldBookEntryViewPrefs: {},
  worldBookListSortDir: 'asc',
  promptBias: '',
  guidedGenerations: [],
  quickReplySets: [],
  toastPosition: 'bottom-right',
  wallpaper: {
    global: null,
    opacity: 0.3,
    fit: 'cover',
    blur: 0,
  },
  useCharacterBackground: false,

  thumbnailSettings: { smallSize: 300, largeSize: 700 },
  pushNotificationPreferences: { enabled: true, events: { generation_ended: true, generation_error: false } },
  chatHeadsEnabled: true,
  chatHeadsSize: 48,
  chatHeadsDirection: 'column' as const,
  chatHeadsOpacity: 1,
  chatHeadsCompletionSoundEnabled: true,
  chatHeadsCustomCompletionSound: null,
  customCSS: { css: '', enabled: false, revision: 0, bundleId: null },
  componentOverrides: {},
  savedThemes: [],
  spindleSettings: {
    interceptorTimeoutMs: 10_000,
    dockPanelDesktopSide: 'right',
    infoLoggingEnabled: true,
    extensionUpdateToastDisabled: {},
  },
  voiceSettings: {
    sttProvider: 'webspeech' as const,
    sttLanguage: 'en-US',
    sttContinuous: false,
    sttInterimResults: true,
    sttAutoSubmitOnSilence: false,
    sttShowMicButton: true,
    sttConnectionId: null,
    ttsEnabled: false,
    ttsConnectionId: null,
    ttsAutoPlay: false,
    ttsSpeed: 1.0,
    ttsVolume: 0.8,
    speechDetectionRules: {
      asterisked: 'skip' as const,
      quoted: 'speech' as const,
      undecorated: 'narration' as const,
    },
    narrationVoice: null,
  },
  ...PRODUCTIVITY_DEFAULTS,

  connectionsOrder: normalizeConnectionsOrder(),

  hydrateStartupSettings: (settings: StartupSettings) => {
    const patch: Record<string, any> = { settingsLoaded: true }

    if (Array.isArray(settings.favorites)) patch.favorites = settings.favorites
    if (Array.isArray(settings.landingHiddenCharacterIds)) {
      patch.landingHiddenCharacterIds = settings.landingHiddenCharacterIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
    }
    if (settings.filterTab) patch.filterTab = settings.filterTab
    if (settings.sortField) patch.sortField = settings.sortField
    if (settings.sortDirection) patch.sortDirection = settings.sortDirection
    if (settings.viewMode) patch.viewMode = settings.viewMode
    if (typeof settings.charactersPerPage === 'number') patch.charactersPerPage = settings.charactersPerPage
    if (typeof settings.favoritesBarCollapsed === 'boolean') patch.favoritesBarCollapsed = settings.favoritesBarCollapsed
    if ('theme' in settings) patch.theme = normalizeTheme(settings.theme)
    if (typeof settings.landingPageChatsDisplayed === 'number' && Number.isFinite(settings.landingPageChatsDisplayed)) {
      patch.landingPageChatsDisplayed = settings.landingPageChatsDisplayed
    }
    if (settings.landingPageLayoutMode === 'cards' || settings.landingPageLayoutMode === 'compact') {
      patch.landingPageLayoutMode = settings.landingPageLayoutMode
    }
    if (settings.landingPageGalleryWidth === 'compact' || settings.landingPageGalleryWidth === 'expanded') {
      patch.landingPageGalleryWidth = settings.landingPageGalleryWidth
    }
    if (settings.wallpaper && typeof settings.wallpaper === 'object') {
      patch.wallpaper = { ...settings.wallpaper }
    }
    if (settings.drawerSettings && typeof settings.drawerSettings === 'object') {
      patch.drawerSettings = { ...get().drawerSettings, ...settings.drawerSettings }
    }
    if (settings.spindleSettings && typeof settings.spindleSettings === 'object') {
      const current = get().spindleSettings
      const disabled = settings.spindleSettings.extensionUpdateToastDisabled
      patch.spindleSettings = {
        ...current,
        ...settings.spindleSettings,
        extensionUpdateToastDisabled:
          disabled && typeof disabled === 'object' && !Array.isArray(disabled)
            ? { ...disabled }
            : current.extensionUpdateToastDisabled,
      }
    }
    if (settings.connectionsOrder && typeof settings.connectionsOrder === 'object') {
      patch.connectionsOrder = normalizeConnectionsOrder(settings.connectionsOrder)
    }

    set(patch as any)
    if (Object.prototype.hasOwnProperty.call(settings, 'activeProfileId')) {
      const raw = settings.activeProfileId
      const id = raw == null || raw === '' ? null : String(raw)
      get().setActiveProfile(id, 'bootstrap_reconcile')
    }
  },

  setVoiceSettings: (partial) =>
    set((state) => {
      const voiceSettings = { ...state.voiceSettings, ...partial }
      if (partial.sttProvider === 'webspeech') {
        voiceSettings.sttConnectionId = null
      }
      if (partial.speechDetectionRules) {
        voiceSettings.speechDetectionRules = { ...state.voiceSettings.speechDetectionRules, ...partial.speechDetectionRules }
      }
      persistKey('voiceSettings', voiceSettings)
      return { voiceSettings }
    }),

  setWallpaper: (partial) =>
    set((state) => {
      const wallpaper = { ...state.wallpaper, ...partial }
      persistKey('wallpaper', wallpaper)
      return { wallpaper }
    }),

  setSetting: (key, value, source: SettingsWriteSource = 'user') => {
    if (key === 'inputBarEnterToSend') {
      get().setInputBarEnterToSend(value as boolean)
      return
    }
    const previous = (get() as unknown as Record<string, unknown>)[key as string]
    const changed = !pendingValuesMatch(previous, value)
    traceSettings('setSetting', {
      key: key as string,
      source,
      changed,
      fullSettingsLoaded: get().fullSettingsLoaded,
      portraitDockBefore: key === 'portraitDockSettings' ? portraitDockTraceSummary(previous) : undefined,
      portraitDockAfter: key === 'portraitDockSettings' ? portraitDockTraceSummary(value) : undefined,
    })
    // No-op writes must not create a newer local revision. Besides avoiding
    // needless PUTs, this keeps an automatic bootstrap observation from
    // winning the load-generation merge solely because its object identity
    // changed.
    if (!changed) return
    set({ [key]: value } as any)
    if (DATA_KEYS.has(key as string)) {
      // Runtime synchronization and migration may observe the default store
      // before the authoritative GET completes. They must not create a local
      // revision that makes the server snapshot look stale. Explicit UI
      // interaction remains allowed during hydration and retains precedence.
      const automatic = source === 'automatic-sync'
        || source === 'state-sync'
        || source === 'portrait-dock-init'
        || source === 'suite-normalization'
        || source === 'suite-reconciliation'
        || source === 'host-load'
        || source === 'compatibility'
      if (!automatic || get().fullSettingsLoaded) {
        persistKey(key as string, value, source)
      } else {
        traceSettings('setSetting:pre-hydration-skip', {
          key: key as string,
          source,
          fullSettingsLoaded: get().fullSettingsLoaded,
          portraitDock: key === 'portraitDockSettings' ? portraitDockTraceSummary(value) : undefined,
        })
      }
    }
  },

  setInputBarEnterToSend: (enabled) => {
    persistDeviceEnterToSend(enabled)
    set({ inputBarEnterToSend: enabled })
  },

  setTheme: (theme) => {
    // Normalize every write so a partial/legacy theme (e.g. from an applied
    // saved-theme snapshot) can never land in the store without an accent.
    const next = theme == null ? null : normalizeTheme(theme)
    set({ theme: next })
    persistKey('theme', next)
  },

  setCharacterThemeOverlay: (characterThemeOverlay) => {
    set({ characterThemeOverlay })
  },

  setCustomCSS: (css) =>
    set((state) => {
      const customCSS = { ...state.customCSS, css, revision: state.customCSS.revision + 1 }
      persistKey('customCSS', customCSS)
      return { customCSS }
    }),

  ensureThemeBundleId: () => {
    const current = get().customCSS.bundleId
    if (current) return current
    const bundleId = generateUUID()
    const customCSS = { ...get().customCSS, bundleId }
    set({ customCSS })
    persistKey('customCSS', customCSS)
    return bundleId
  },

  toggleCustomCSS: (enabled) =>
    set((state) => {
      const customCSS = { ...state.customCSS, enabled }
      persistKey('customCSS', customCSS)
      return { customCSS }
    }),

  setComponentCSS: (componentName, css) =>
    set((state) => {
      const prev = state.componentOverrides[componentName]
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { css, tsx: prev?.tsx ?? '', enabled: prev?.enabled ?? true },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  setComponentTSX: (componentName, tsx) =>
    set((state) => {
      const prev = state.componentOverrides[componentName]
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { tsx, css: prev?.css ?? '', enabled: prev?.enabled ?? true },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  toggleComponentOverride: (componentName, enabled) =>
    set((state) => {
      const existing = state.componentOverrides[componentName]
      if (!existing) return {}
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { ...existing, enabled },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  resetAllOverrides: () => {
    const componentOverrides = {}
    const customCSS = { ...get().customCSS, css: '', enabled: false, revision: 0 }
    persistKey('componentOverrides', componentOverrides)
    persistKey('customCSS', customCSS)
    set({ componentOverrides, customCSS })
  },

  applyThemePack: (pack) => {
    const patch: Record<string, any> = {}

    // Layer 1: Theme config — normalize so an imported pack whose theme lost
    // its accent can't crash the app on the next load.
    const packTheme = normalizeTheme(pack.theme)
    if (packTheme) {
      // Desktop translucency was added after existing theme packs. Treat an
      // omitted field as “leave the native-wrapper preference unchanged”; an
      // explicit field in the pack remains authoritative.
      const theme = {
        ...packTheme,
        desktopBackground: packTheme.desktopBackground ?? get().theme?.desktopBackground,
      }
      patch.theme = theme
      persistKey('theme', theme)
    }

    // Layer 2: Global CSS
    const customCSS = {
      css: pack.globalCSS || '',
      enabled: !!pack.globalCSS.trim(),
      revision: Date.now(),
      bundleId: pack.bundleId || generateUUID(),
    }
    patch.customCSS = customCSS
    persistKey('customCSS', customCSS)

    // Layer 3: Component overrides
    const componentOverrides: Record<string, any> = {}
    for (const [name, comp] of Object.entries(pack.components)) {
      componentOverrides[name] = { css: comp.css || '', tsx: comp.tsx || '', enabled: comp.enabled }
    }
    patch.componentOverrides = componentOverrides
    persistKey('componentOverrides', componentOverrides)

    set(patch as any)
  },

  addSavedTheme: (input) => {
    const entry = {
      ...input,
      id: generateUUID(),
      createdAt: Math.floor(Date.now() / 1000),
    } as import('@/types/store').SavedTheme
    const savedThemes = [...get().savedThemes, entry]
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)
    return entry
  },

  renameSavedTheme: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const savedThemes = get().savedThemes.map((entry) =>
      entry.id === id ? { ...entry, name: trimmed.slice(0, 200) } : entry
    )
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)
  },

  deleteSavedTheme: async (id) => {
    const entry = get().savedThemes.find((e) => e.id === id)
    if (!entry) return
    const savedThemes = get().savedThemes.filter((e) => e.id !== id)
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)
    // Clean up bundle assets for pack entries, unless the bundle is still the
    // active customCSS bundle (i.e. the user is currently using it).
    if (entry.kind === 'pack') {
      const activeBundleId = get().customCSS.bundleId
      const packBundleId = entry.pack.bundleId
      if (packBundleId && packBundleId !== activeBundleId) {
        try {
          const assets = await themeAssetsApi.list(packBundleId)
          await Promise.all(assets.map((a) => themeAssetsApi.delete(a.id).catch(() => {})))
        } catch {
          // Swallow — orphaned assets are non-fatal; the user can prune manually.
        }
      }
    }
  },

  applySavedTheme: (id) => {
    const entry = get().savedThemes.find((e) => e.id === id)
    if (!entry) return
    if (entry.kind === 'config') {
      const theme = {
        ...entry.theme,
        desktopBackground: entry.theme.desktopBackground ?? get().theme?.desktopBackground,
      }
      get().setTheme(theme)
    } else {
      get().applyThemePack(entry.pack)
    }
  },

  updateSavedTheme: async (id) => {
    const state = get()
    const currentTheme = state.theme ?? DEFAULT_THEME
    const savedThemes = state.savedThemes.map((entry) => {
      if (entry.id !== id) return entry
      if (entry.kind === 'config') {
        return { ...entry, theme: currentTheme } as typeof entry
      }

      // A pack owns all three theme layers. Saving only its ThemeConfig made
      // re-applying it restore its previous global CSS and component overrides,
      // discarding the user's current edits.
      const components = Object.fromEntries(
        Object.entries(state.componentOverrides)
          .filter(([, override]) => override.css?.trim() || override.tsx?.trim())
          .map(([name, override]) => [name, {
            css: override.css || '',
            tsx: override.tsx || '',
            enabled: override.enabled,
          }]),
      )
      return {
        ...entry,
        pack: {
          ...entry.pack,
          theme: currentTheme,
          globalCSS: state.customCSS.css || '',
          components,
        },
      } as typeof entry
    })
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)
    // This action is explicitly destructive to the previous snapshot, so do
    // not leave its replacement vulnerable to a reload or navigation during
    // the normal settings debounce window.
    await flushSettingsNow()
  },

  loadSettings: async () => {
    const loadGeneration = settingsLoadGeneration.begin()
    const isCurrentLoad = () => settingsLoadGeneration.isCurrent(loadGeneration)
    settingsSelectionAbort?.abort()
    const selectionAbort = new AbortController()
    settingsSelectionAbort = selectionAbort
    let selection: PresetSelectionRequest | null = null
    const localRevisionAtLoadStart = localSettingsRevision
    traceSettings('loadSettings:start', {
      loadGeneration,
      localRevisionAtLoadStart,
      unsaved: hasUnsavedSettings(),
      dirtyKeys: [...dirtyKeys.keys()],
      portraitDockBefore: portraitDockTraceSummary(get().portraitDockSettings),
    })
    try {
      selection = beginActiveLoomPresetSelection({ signal: selectionAbort.signal })
      const rows = await settingsApi.getAll()
      traceSettings('loadSettings:rows', {
        loadGeneration,
        current: isCurrentLoad(),
        rowCount: rows.length,
        keys: rows.map((row) => row.key),
        canonicalPortraitDock: portraitDockTraceSummary(
          rows.find((row) => row.key === 'portraitDockSettings')?.value,
        ),
        compatibilityPortraitDock: portraitDockTraceSummary(
          rows.find((row) => row.key === PRODUCTIVITY_PRIVATE_FALLBACKS.portraitDockSettings?.[0])?.value,
        ),
      })
      if (!isCurrentLoad()) return
      const patch: Record<string, any> = {}
      const migratedProductivityKeys = new Set<string>()
      const promotedProductivityFallbacks = new Set<string>()
      const defaults = get()
      const pendingImageGenerationPatch = {
        ...(readPendingImageGenerationPatch() ?? {}),
        ...(defaults.pendingImageGenerationPatch ?? {}),
      }
      const hasPendingImageGenerationPatch = Object.keys(pendingImageGenerationPatch).length > 0
      let reconciledImageGeneration = false
      let migratedCharacterFilterTab = false
      const legacySettingsToPersist: Record<string, unknown> = {}
      // Retroactive purge: `activeLumiPresetId` was a defunct preset pointer
      // that still ghost-drove generation for users with a stale value. It has
      // no UI setter; wipe it from the DB on load so it stops resolving to a
      // preset behind the user's back.
      if (rows.some((r) => r.key === 'activeLumiPresetId')) {
        if (!isCurrentLoad()) return
        settingsApi.delete('activeLumiPresetId').catch(() => {})
      }
      // A legacy host may have persisted only the namespaced compatibility row.
      // Promote that row into the canonical hydration stream once; after this
      // point the canonical blob is the sole authority and the mirror is
      // repaired from it below.
      const hydrationRows = [...rows]
      const rowsByKey = new Map(rows.map((row) => [row.key, row]))
      for (const [key, fallbackKeys] of Object.entries(PRODUCTIVITY_PRIVATE_FALLBACKS)) {
        if (rowsByKey.has(key)) continue
        const fallback = fallbackKeys.map((fallbackKey) => rowsByKey.get(fallbackKey)).find(Boolean)
        if (!fallback) continue
        hydrationRows.push({ ...fallback, key })
        promotedProductivityFallbacks.add(key)
      }
      for (const row of hydrationRows) {
        const canonicalKey = LEGACY_SETTINGS_KEY_RENAMES[row.key] ?? row.key
        if (
          !DATA_KEYS.has(canonicalKey)
          || hasNewerLocalSetting(canonicalKey, localRevisionAtLoadStart)
          // Prefer a canonical setting row when both its legacy and current
          // names are present in the account.
          || (canonicalKey !== row.key && rows.some((candidate) => candidate.key === canonicalKey))
        ) continue
        const storedValue = canonicalKey === 'imageGeneration'
          ? migrateStoredImageGeneration(row.value)
          : migrateProductivitySetting(canonicalKey, row.value)
        if (canonicalKey === 'quickToolbarSettings' && !pendingValuesMatch(storedValue, row.value)) {
          migratedProductivityKeys.add(canonicalKey)
        }
        patch[canonicalKey] = mergeStoredSetting((defaults as any)[canonicalKey], storedValue)
        if (canonicalKey !== row.key) legacySettingsToPersist[canonicalKey] = patch[canonicalKey]
      }

      // This preference was historically synced with the account. Seed each
      // device once from that committed backend row, then keep later changes
      // local so phones and desktops can choose different send-key behavior.
      const deviceEnterToSend = readDeviceEnterToSend()
      if (deviceEnterToSend !== null) {
        patch.inputBarEnterToSend = deviceEnterToSend
      } else {
        const backendEnterToSend = rows.find((row) => row.key === 'inputBarEnterToSend')?.value
          ?? rows.find((row) => row.key === LEGACY_ENTER_TO_SEND_SETTING_KEY)?.value
        const migratedEnterToSend = typeof backendEnterToSend === 'boolean'
          ? backendEnterToSend
          : defaults.inputBarEnterToSend
        persistDeviceEnterToSend(migratedEnterToSend)
        patch.inputBarEnterToSend = migratedEnterToSend
      }

      // Recover any settings the previous page wrote to localStorage but may
      // not have persisted to the DB yet (keepalive flush races with this GET).
      const pendingKeys = readPendingSettings()
      if (pendingKeys) {
        for (const [k, v] of Object.entries(pendingKeys)) {
          if (
            !DATA_KEYS.has(k)
            || hasNewerLocalSetting(k, localRevisionAtLoadStart)
          ) continue
          const pendingValue = k === 'imageGeneration'
            ? migrateStoredImageGeneration(v)
            : migrateProductivitySetting(k, v)
          if (k === 'quickToolbarSettings' && !pendingValuesMatch(pendingValue, v)) {
            migratedProductivityKeys.add(k)
          }
          patch[k] = mergeStoredSetting(patch[k] ?? (defaults as any)[k], pendingValue)
        }
      }

      if (!isCurrentLoad()) return
      // Migration: discard old ThemeConfig shape (has baseColors but no accent)
      if (patch.theme && 'baseColors' in patch.theme && !('accent' in patch.theme)) {
        patch.theme = null
      }
      // Backfill any surviving non-null theme against DEFAULT_THEME so a missing
      // `accent` (partial write, imported pack, hand-edited value) can't throw in
      // generateThemeVariables / ThemePanel and white-screen the app on load.
      if (patch.theme) {
        patch.theme = normalizeTheme(patch.theme)
      }
      if (patch.filterTab === 'all') {
        patch.filterTab = 'characters'
        migratedCharacterFilterTab = true
      }
      if (pendingKeys?.filterTab === 'all') {
        pendingKeys.filterTab = 'characters'
        migratedCharacterFilterTab = true
      }
      if (patch.connectionsOrder) {
        patch.connectionsOrder = normalizeConnectionsOrder(patch.connectionsOrder)
      }
      if (
        hasPendingImageGenerationPatch
        && !hasNewerLocalSetting('imageGeneration', localRevisionAtLoadStart)
      ) {
        patch.imageGeneration = {
          ...(patch.imageGeneration ?? defaults.imageGeneration),
          ...pendingImageGenerationPatch,
        }
        patch.pendingImageGenerationPatch = undefined
      }

      if (patch.imageGeneration) {
        const savedConnectionId = patch.imageGeneration.activeImageGenConnectionId ?? null
        if (get().imageGenProfilesLoaded) {
          const profiles = get().imageGenProfiles
          const activeImageGenConnectionId = savedConnectionId && profiles.some((profile) => profile.id === savedConnectionId && profile.review_required !== true)
            ? savedConnectionId
            : profiles.find((profile) => profile.is_default && profile.review_required !== true)?.id ?? null
          patch.activeImageGenConnectionId = activeImageGenConnectionId
          if (activeImageGenConnectionId !== savedConnectionId) {
            patch.imageGeneration = { ...patch.imageGeneration, activeImageGenConnectionId }
            reconciledImageGeneration = true
          }
        } else {
          // The profile request has not established whether the saved ID is valid.
          // Preserve it until setImageGenProfiles can reconcile against real data.
          patch.activeImageGenConnectionId = savedConnectionId
        }
      }
      const requestedActiveLoomPresetId = patch.activeLoomPresetId as string | null | undefined
      const hasIncomingActiveProfileId = Object.prototype.hasOwnProperty.call(patch, 'activeProfileId')
      const incomingActiveProfileId = hasIncomingActiveProfileId ? patch.activeProfileId : undefined
      if (!isCurrentLoad()) return
      delete patch.activeLoomPresetId
      if (hasIncomingActiveProfileId) delete patch.activeProfileId
      if (Object.keys(patch).length > 0) {
        traceSettings('loadSettings:merge', {
          loadGeneration,
          keys: Object.keys(patch),
          skippedNewerLocalKeys: rows
            .map((row) => row.key)
            .filter((key) => DATA_KEYS.has(key) && hasNewerLocalSetting(key, localRevisionAtLoadStart)),
          portraitDockBefore: portraitDockTraceSummary(get().portraitDockSettings),
          portraitDockIncoming: portraitDockTraceSummary(patch.portraitDockSettings),
          portraitDockServerDockSide: portraitDockTraceSummary(
            rows.find((row) => row.key === 'portraitDockSettings')?.value,
          )?.dockSide,
          portraitDockServerDefaultDockSide: portraitDockTraceSummary(
            rows.find((row) => row.key === 'portraitDockSettings')?.value,
          )?.defaultDockSide,
          portraitDockServerRememberSizePosition: portraitDockTraceSummary(
            rows.find((row) => row.key === 'portraitDockSettings')?.value,
          )?.rememberSizePosition,
          portraitDockLocalDockSide: get().portraitDockSettings.dockSide,
          portraitDockLocalDefaultDockSide: get().portraitDockSettings.defaultDockSide,
          portraitDockLocalRememberSizePosition: get().portraitDockSettings.rememberSizePosition,
          portraitDockIncomingDockSide: portraitDockTraceSummary(patch.portraitDockSettings)?.dockSide,
          portraitDockIncomingDefaultDockSide: portraitDockTraceSummary(patch.portraitDockSettings)?.defaultDockSide,
          portraitDockIncomingRememberSizePosition: portraitDockTraceSummary(patch.portraitDockSettings)?.rememberSizePosition,
          portraitDockRevisionAtLoadStart: localRevisionAtLoadStart,
          portraitDockCurrentRevision: localSettingRevisions.get('portraitDockSettings') ?? 0,
        })
        set(patch as any)
        traceSettings('loadSettings:merged', {
          loadGeneration,
          portraitDockAfter: portraitDockTraceSummary(get().portraitDockSettings),
        })
        if (!isCurrentLoad()) return
      }
      if (hasIncomingActiveProfileId) {
        const id = incomingActiveProfileId == null || incomingActiveProfileId === ''
          ? null
          : String(incomingActiveProfileId)
        get().setActiveProfile(id, 'settings_reconcile')
        if (!isCurrentLoad()) return
      }
      if (requestedActiveLoomPresetId !== undefined && selection) {
        if (!isCurrentLoad()) return
        await selection.transition(requestedActiveLoomPresetId)
        if (!isCurrentLoad()) return
      }

      // Reorder profile slices to match persisted connectionsOrder. Without
      // this, consumers that read state.profiles directly (input bar dropdown,
      // ConnectionSelect, etc.) keep the backend order until the user drags
      // something in the panel — which is the visible divergence C3 found.
      if (patch.connectionsOrder) {
        if (!isCurrentLoad()) return
        const order = patch.connectionsOrder as ConnectionsOrder
        const args = deriveReorderArgs(order, {
          llm: get().profiles,
          imageGen: get().imageGenProfiles,
          stt: get().sttProfiles,
          tts: get().ttsProfiles,
        })
        if (args.llm) {
          if (!isCurrentLoad()) return
          get().applyProfileOrder(args.llm)
        }
        if (args.imageGen) {
          if (!isCurrentLoad()) return
          get().applyImageGenProfileOrder(args.imageGen)
        }
        if (args.stt) {
          if (!isCurrentLoad()) return
          get().applySttProfileOrder(args.stt)
        }
        if (args.tts) {
          if (!isCurrentLoad()) return
          get().applyTtsProfileOrder(args.tts)
        }
      }
      if (migratedCharacterFilterTab) {
        if (!isCurrentLoad()) return
        persistKey('filterTab', 'characters')
      }

      // Full settings are now authoritative. Queue recovered bridge values
      // through the same serialized persistence path as normal edits; a bridged
      // image-generation row still waits for profile reconciliation when needed.
      if (!isCurrentLoad()) return
      set({ fullSettingsLoaded: true })
      traceSettings('loadSettings:hydrated', {
        loadGeneration,
        pendingKeys: pendingKeys ? Object.keys(pendingKeys) : [],
        portraitDock: portraitDockTraceSummary(get().portraitDockSettings),
      })
      // Compatibility rows are repaired only after canonical hydration has
      // completed; they are never allowed to race or lead the initial load.
      // Persist one-shot productivity migrations as well. Without this
      // write-through, every SETTINGS_UPDATED/load cycle re-reads the stale
      // V2 chat-column rectangle and the extension can put it back in memory.
      for (const key of migratedProductivityKeys) {
        const value = patch[key]
        if (value !== undefined) persistKey(key, value, 'suite-normalization')
      }
      for (const key of promotedProductivityFallbacks) {
        const value = patch[key]
        if (value !== undefined) persistKey(key, value, 'suite-normalization')
      }
      persistProductivityFallbacks(patch, new Map(rows.map((row) => [row.key, row.value])))
      for (const [key, value] of Object.entries(legacySettingsToPersist)) {
        if (!isCurrentLoad()) return
        persistKey(key, value, 'compatibility')
      }
      if (pendingKeys) {
        for (const [key, value] of Object.entries(pendingKeys)) {
          if (!DATA_KEYS.has(key) || key === 'imageGeneration') continue
          if (!isCurrentLoad()) return
          persistKey(key, patch[key] ?? value)
        }
      }
      const hasPendingImageGeneration = Boolean(
        pendingKeys && Object.prototype.hasOwnProperty.call(pendingKeys, 'imageGeneration'),
      )
      if (
        patch.imageGeneration
        && (
          reconciledImageGeneration
          || hasPendingImageGenerationPatch
          || (get().imageGenProfilesLoaded && hasPendingImageGeneration)
        )
      ) {
        if (!isCurrentLoad()) return
        persistKey('imageGeneration', patch.imageGeneration)
      }
    } catch (err) {
      if (isCurrentLoad()) {
        traceSettings('loadSettings:failed', { loadGeneration })
        console.error('[settings] Failed to load settings:', err)
      }
    } finally {
      selection?.cancel()
      if (settingsSelectionAbort === selectionAbort) {
        settingsSelectionAbort = null
      }
      if (isCurrentLoad()) {
        set({ settingsLoaded: true })
        traceSettings('loadSettings:finished', {
          loadGeneration,
          fullSettingsLoaded: get().fullSettingsLoaded,
          portraitDock: portraitDockTraceSummary(get().portraitDockSettings),
        })
      }
    }
  },
})
