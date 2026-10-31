import { createOrganizationWriter } from '@/lib/connection-organization-writes'
import { get as getApi } from '@/api/client'
import { ORGANIZATION_KEYS, organizationEdits, type OrganizationSettingKey } from '../../../../src/shared/connection-organization-edits'
import type { StateCreator } from 'zustand'
import type { AppStore, EnterToSendSettings, SettingsSlice, StartupSettings, ThemeConfig, ReasoningSettings, SettingsWriteSource, ToastPosition } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { DEFAULT_UI_LANGUAGE, isUiLanguage } from '@/i18n/languages'
import { themeAssetsApi } from '@/api/theme-assets'
import { BASE_URL } from '@/api/client'
import { activeTab } from '@/lib/active-tab'
import { beginActiveLoomPresetSelection, type PresetSelectionRequest } from '@/lib/loom/preset-selection-coordinator'
import { generateUUID } from '@/lib/uuid'
import { restoreThemePackComponents } from '@/lib/themePack'
import { uploadThemePackAssets } from '@/lib/themePackAssets'
import { DEFAULT_THEME, normalizeTheme } from '@/theme/presets'
import { setDeviceThemeControlsScope } from '@/lib/deviceThemeControls'
import { PRODUCTIVITY_DEFAULTS, migrateProductivitySetting } from '@/lib/uiProductivityDefaults'
import { isMobileViewportOrDevice } from '@/lib/mobile'
import { DEFAULT_IMPERSONATION_MODE, resolveImpersonationMode } from '@/lib/impersonationPreset'
import { isChatImageSize, isChatImageAlignment, isChatImageTargets, DEFAULT_CHAT_IMAGE_TARGETS } from '@/lib/chatImagePresentation'
import { whistleLanguage } from '@/lib/whistle/config'
import { createSettingsLoadGenerationGuard } from './settings-load-generation'
import {
  deriveReorderArgs,
  normalizeConnectionsOrder,
  type ConnectionsOrder,
} from './connections-order-merge'

/** Default reasoning settings — used until the user has an unbound preference. */
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
  'uiLanguage',
  'landingPageChatsDisplayed',
  'landingPageLayoutMode',
  'landingPageGalleryWidth',
  'landingHiddenCharacterIds',
  'charactersPerPage',
  'personasPerPage',
  'messagesPerPage',
  'chatDisplayMode',
  'showGreetingImage',
  'greetingImagePosition',
  'chatImageSize',
  'chatImageAlignment',
  'chatImageTargets',
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
  'composerActionBar',
  'defaultImpersonationMode',
  'chatWidthMode',
  'centerChatWithSidebar',
  'chatContentMaxWidth',
  'modalWidthMode',
  'modalMaxWidth',
  'portraitPanelSide',
  'desktopPinchZoomEnabled',
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
  'importChubExpressions',
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
  'unboundReasoningSettings',
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
  'connectionLibraries',
  'recentConnections',
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

/** Toast corner values accepted from storage; mirrors the ToastPosition union. */
const TOAST_POSITIONS: ReadonlySet<string> = new Set([
  'top-right',
  'top-left',
  'bottom-right',
  'bottom-left',
  'top',
  'bottom',
])

function isToastPosition(value: unknown): value is ToastPosition {
  return typeof value === 'string' && TOAST_POSITIONS.has(value)
}

function isValidSettingValue(key: string, value: unknown): boolean {
  if (key === 'uiLanguage') return isUiLanguage(value)
  if (key === 'chatImageSize') return isChatImageSize(value)
  if (key === 'chatImageAlignment') return isChatImageAlignment(value)
  if (key === 'chatImageTargets') return isChatImageTargets(value)
  if (key === 'showGreetingImage') return typeof value === 'boolean'
  if (key === 'greetingImagePosition') return value === 'top' || value === 'bottom'
  return true
}

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

/** Per-user, per-device preferences; seeded once from the legacy scalar value. */
export const DEVICE_ENTER_TO_SEND_STORAGE_KEY = 'lumiverse:device:input-bar-enter-to-send'
export const DEFAULT_ENTER_TO_SEND_SETTINGS: Readonly<EnterToSendSettings> = Object.freeze({
  desktop: true,
  mobile: false,
})
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

function parseEnterToSendSettings(value: unknown): EnterToSendSettings | null {
  if (!isPlainObject(value)) return null
  return {
    desktop: typeof value.desktop === 'boolean' ? value.desktop : DEFAULT_ENTER_TO_SEND_SETTINGS.desktop,
    mobile: typeof value.mobile === 'boolean' ? value.mobile : DEFAULT_ENTER_TO_SEND_SETTINGS.mobile,
  }
}

function readDeviceEnterToSend(): EnterToSendSettings | boolean | null {
  try {
    const value = localStorage.getItem(deviceEnterToSendStorageKey())
    if (value === 'true') return true
    if (value === 'false') return false
    if (value !== null) return parseEnterToSendSettings(JSON.parse(value))
  } catch {}
  return null
}

function persistDeviceEnterToSend(value: EnterToSendSettings): void {
  try {
    localStorage.setItem(deviceEnterToSendStorageKey(), JSON.stringify(value))
  } catch {
    // The setting remains usable when browser storage is unavailable.
  }
}

/** Select the authenticated user's local persistence bridge. */
export function setSettingsPersistenceScope(userId: string | null): void {
  persistenceScope = userId
  setDeviceThemeControlsScope(userId)
}

let organizationWriter: ReturnType<typeof createOrganizationWriter> | undefined
let organizationWriterGeneration = -1
let deferredOrganizationReload = false
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
  if (activeTab.signal.aborted) return
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
    if (!isPlainObject(parsed)) return null
    for (const key of ORGANIZATION_KEYS) delete parsed[key]
    return parsed
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
  if (activeTab.signal.aborted) return
  const pending = readPendingImageGenerationPatch() ?? {}
  Object.assign(pending, patch)
  try {
    localStorage.setItem(bridgeStorageKey(PENDING_IMAGE_GENERATION_PATCH_KEY), JSON.stringify(pending))
  } catch {}
}

function clearPendingImageGenerationPatch(): void {
  if (activeTab.signal.aborted) return
  try { localStorage.removeItem(bridgeStorageKey(PENDING_IMAGE_GENERATION_PATCH_KEY)) } catch {}
}

function mergePendingSettings(batch: Record<string, unknown>): boolean {
  if (activeTab.signal.aborted) return false
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
  if (activeTab.signal.aborted) return
  const pending = readPendingSettings()
  if (!pending || !Object.prototype.hasOwnProperty.call(pending, key)) return
  pending[key] = value
  try {
    localStorage.setItem(bridgeStorageKey(PENDING_SETTINGS_KEY), JSON.stringify(pending))
  } catch {}
}

export function clearPendingSettings(persisted: Record<string, unknown>): void {
  if (activeTab.signal.aborted) return
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

function mergeStoredSetting(defaultValue: any, storedValue: any, settingKey?: string): any {
  // These maps are complete snapshots. Deep merging with the previous load
  // resurrects removed assignments or histories after another tab saves them.
  if (settingKey === 'connectionLibraries' || settingKey === 'recentConnections') {
    return isPlainObject(storedValue) ? storedValue : {}
  }
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

/** Rewrites the removed 'sidecar' API source to the active connection. */
export function migrateStoredSummarization(storedValue: any): any {
  if (isPlainObject(storedValue) && storedValue.apiSource === 'sidecar') {
    return { ...storedValue, apiSource: 'active' }
  }
  return storedValue
}

function migrateStoredSettingValue(key: string, value: any): any {
  let migrated = key === 'imageGeneration' ? migrateStoredImageGeneration(value) : value
  migrated = migrateProductivitySetting(key, migrated)
  migrated = key === 'summarization' ? migrateStoredSummarization(migrated) : migrated
  migrated = key === 'defaultImpersonationMode' ? resolveImpersonationMode(migrated) : migrated
  return migrated
}

/** Immediately flush any pending settings (e.g. on page unload). */
export function flushSettings() {
  if (activeTab.signal.aborted) return
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
  if (organizationWriter?.pending) return organizationWriter.flush().then(() => flushSettingsNow())
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
  return !!organizationWriter?.pending || dirtyKeys.size > 0 || flushInFlight || activeFlushPromise !== null
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
  // This navigation bookmark is not hydrated by loadSettings. Other clients
  // still receive its event; it never justifies reloading all settings/presets.
  const keys = settingsUpdateKeys(payload)
  if (keys.length > 0 && keys.every((key) => key === 'activeChatId')) return false
  if (organizationWriter?.pending) deferredOrganizationReload = true
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
  organizationWriter?.dispose()
  organizationWriter = undefined
  deferredOrganizationReload = false
  persistenceGeneration += 1
  settingsLoadGeneration.begin()
  dirtyKeys.clear()
  flushInFlight = false
  activeFlushPromise = null
  activeFlushBatch = null
  lastCommittedSettingsKeys.clear()
  persistenceScope = null
  setDeviceThemeControlsScope(null)
}

// Flush on page unload so slider drags / rapid changes are never lost
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', event => {
    // Organization intent is deliberately not saved in browser storage. Let the
    // user wait for its server acknowledgement before leaving the page.
    if (organizationWriter?.pending) { event.preventDefault(); event.returnValue = '' }
    flushSettings()
  })
}

function applyConnectionOrder(state: AppStore, order: ConnectionsOrder | undefined, isCurrent = () => true) {
  if (!order) return
  const args = deriveReorderArgs(order, { llm: state.profiles ?? [], imageGen: state.imageGenProfiles ?? [],
    stt: state.sttProfiles ?? [], decision: state.decisionProfiles ?? [], tts: state.ttsProfiles ?? [] })
  const apply = { llm: state.applyProfileOrder, imageGen: state.applyImageGenProfileOrder,
    stt: state.applySttProfileOrder, decision: state.applyDecisionProfileOrder, tts: state.applyTtsProfileOrder }
  for (const kind of Object.keys(apply) as Array<keyof typeof apply>) {
    if (!isCurrent()) return
    if (args[kind]) apply[kind]?.(args[kind])
  }
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  uiLanguage: null,
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
  showGreetingImage: false,
  greetingImagePosition: 'top',
  chatImageSize: 'default',
  chatImageAlignment: 'left',
  chatImageTargets: { ...DEFAULT_CHAT_IMAGE_TARGETS },
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
  inputBarEnterToSend: { ...DEFAULT_ENTER_TO_SEND_SETTINGS },
  saveDraftInput: true,
  composerActionBar: null,
  defaultImpersonationMode: DEFAULT_IMPERSONATION_MODE,
  chatWidthMode: 'full',
  centerChatWithSidebar: false,
  chatContentMaxWidth: 900,
  modalWidthMode: 'full',
  modalMaxWidth: 900,
  portraitPanelSide: 'right',
  desktopPinchZoomEnabled: false,
  theme: null,
  characterThemeOverlay: null,
  drawerSettings: {
    side: 'right',
    verticalPosition: 15,
    tabSize: 'large',
    panelWidthMode: 'default',
    customPanelWidth: 35,
    showTabLabels: true,
    duoAlwaysOpen: true,
    hiddenTabIds: [],
    tabOrder: [],
    layout: [],
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
  unboundReasoningSettings: null,
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
  importChubExpressions: true,
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
    mobile: null,
    opacity: 0.3,
    fit: 'cover',
    blur: 0,
  },
  useCharacterBackground: false,

  thumbnailSettings: { smallSize: 300, largeSize: 700 },
  pushNotificationPreferences: { enabled: true, events: { generation_ended: true, generation_error: true } },
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

  recentConnections: {},
  connectionLibraries: {},
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
    if (typeof settings.importChubExpressions === 'boolean') patch.importChubExpressions = settings.importChubExpressions
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
    if (isToastPosition(settings.toastPosition)) {
      patch.toastPosition = settings.toastPosition
    }
    if (settings.defaultImpersonationMode) {
      patch.defaultImpersonationMode = resolveImpersonationMode(settings.defaultImpersonationMode)
    }
    if (typeof settings.showGreetingImage === 'boolean') {
      patch.showGreetingImage = settings.showGreetingImage
    }
    if (settings.greetingImagePosition === 'top' || settings.greetingImagePosition === 'bottom') {
      patch.greetingImagePosition = settings.greetingImagePosition
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
      if (partial.sttProvider === 'webspeech' || partial.sttProvider === 'whistle') {
        voiceSettings.sttConnectionId = null
      }
      if (partial.sttProvider === 'whistle') {
        voiceSettings.sttLanguage = whistleLanguage(voiceSettings.sttLanguage) || 'auto'
      } else if (partial.sttProvider) {
        const locales: Record<string, string> = {
          auto: 'en-US', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
        }
        voiceSettings.sttLanguage = locales[voiceSettings.sttLanguage] || voiceSettings.sttLanguage
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
    if (key === 'uiLanguage' && !isUiLanguage(value)) return
    if (key === 'inputBarEnterToSend') {
      get().setInputBarEnterToSend(value as EnterToSendSettings)
      return
    }
    const state = get()
    const previous = (state as unknown as Record<string, unknown>)[key as string]
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
    if ((ORGANIZATION_KEYS as readonly string[]).includes(key as string)) {
      if (!state.fullSettingsLoaded) return
      const edits = organizationEdits(key as OrganizationSettingKey, previous, value)
      if (!edits.length) return
      if (!organizationWriter || organizationWriterGeneration !== persistenceGeneration) {
        organizationWriter?.dispose()
        organizationWriterGeneration = persistenceGeneration
        const generation = persistenceGeneration
        organizationWriter = createOrganizationWriter({
          commit: values => {
            if (generation !== persistenceGeneration) return
            for (const organizationKey of ORGANIZATION_KEYS) localSettingRevisions.set(organizationKey, ++localSettingsRevision)
            set(values as Partial<AppStore>)
            applyConnectionOrder(get(), values.connectionsOrder as ConnectionsOrder)
          },
          failed: async () => {
            if (generation !== persistenceGeneration) return
            get().addToast({ type: 'error', message: 'Connection organization could not be saved. Reloading saved folders and order.' })
            return getApi<Record<string, unknown>>('/connections/organization')
          },
          settled: () => {
            if (generation !== persistenceGeneration || !deferredOrganizationReload) return
            deferredOrganizationReload = false
            void get().loadSettings()
          },
        })
      }
      // Organization operations bypass the whole-blob debounce and localStorage recovery bridge.
      for (const organizationKey of ORGANIZATION_KEYS) dirtyKeys.delete(organizationKey)
      localSettingRevisions.set(key as string, ++localSettingsRevision)
      set({ [key]: value } as Partial<AppStore>)
      organizationWriter.enqueue(edits)
      return
    }
    let unboundReasoningSettings: ReasoningSettings | undefined
    if (
      key === 'reasoningSettings'
      && !state.profiles?.find((profile) => profile.id === state.activeProfileId)?.metadata?.reasoningBindings?.settings
    ) {
      const next = value as ReasoningSettings
      unboundReasoningSettings = { ...(state.unboundReasoningSettings ?? state.reasoningSettings) }
      // Only user-edited fields replace the preference. A provider may have
      // mapped the displayed effort to a supported tier in the meantime.
      const fields = new Set([
        ...Object.keys(state.reasoningSettings),
        ...Object.keys(next),
      ]) as Set<keyof ReasoningSettings>
      for (const field of fields) {
        if (pendingValuesMatch(state.reasoningSettings[field], next[field])) continue
        if (field in next) Object.assign(unboundReasoningSettings, { [field]: next[field] })
        else delete unboundReasoningSettings[field]
      }
    }
    set({ [key]: value, ...(unboundReasoningSettings ? { unboundReasoningSettings } : {}) } as any)
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
        if (unboundReasoningSettings) persistKey('unboundReasoningSettings', unboundReasoningSettings, source)
        // Persist a language selection before the app can be closed or opened
        // on another device; the pending-settings bridge still covers failures.
        if (key === 'uiLanguage' && source === 'user') {
          void flushSettingsNow().catch(() => {})
        }
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

  setInputBarEnterToSend: (settings) => {
    const normalized = parseEnterToSendSettings(settings) ?? { ...DEFAULT_ENTER_TO_SEND_SETTINGS }
    persistDeviceEnterToSend(normalized)
    set({ inputBarEnterToSend: normalized })
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
        name: pack.name?.trim() || packTheme.name,
        desktopBackground: packTheme.desktopBackground ?? get().theme?.desktopBackground,
        renderingMode: pack.theme?.renderingMode ?? get().theme?.renderingMode,
      }
      patch.theme = theme
      persistKey('theme', theme)
    }

    // Layer 2: Global CSS
    const customCSS = {
      css: pack.globalCSS || '',
      enabled: pack.globalCSSEnabled ?? !!pack.globalCSS.trim(),
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
    const trimmed = name.trim().slice(0, 200)
    if (!trimmed) return
    const existing = get().savedThemes.find((entry) => entry.id === id)
    if (!existing) return
    const savedThemes = get().savedThemes.map((entry) => {
      if (entry.id !== id) return entry
      if (entry.kind === 'config') {
        return { ...entry, name: trimmed, theme: { ...entry.theme, name: trimmed } }
      }
      return {
        ...entry,
        name: trimmed,
        pack: {
          ...entry.pack,
          name: trimmed,
          theme: entry.pack.theme ? { ...entry.pack.theme, name: trimmed } : null,
        },
      }
    })
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)

    // Keep the live ThemeConfig aligned when the renamed bundle is active.
    // This also repairs packs created before saved-theme names were canonical.
    if (
      existing.kind === 'pack'
      && existing.pack.bundleId
      && existing.pack.bundleId === get().customCSS.bundleId
      && get().theme
    ) {
      get().setTheme({ ...get().theme!, name: trimmed })
    } else if (existing.kind === 'config' && get().theme === existing.theme) {
      // Newly saved config themes retain object identity until hydration, so
      // the inline rename can immediately become the live theme name too.
      get().setTheme({ ...existing.theme, name: trimmed })
    }
  },

  deleteSavedTheme: async (id) => {
    const entry = get().savedThemes.find((e) => e.id === id)
    if (!entry) return
    const savedThemes = get().savedThemes.filter((e) => e.id !== id)
    set({ savedThemes })
    persistKey('savedThemes', savedThemes)
    // Backups can share a bundle with other saved themes.
    if (entry.kind === 'pack') {
      const packBundleId = entry.pack.bundleId
      const isReferenced = () => get().customCSS.bundleId === packBundleId
        || get().savedThemes.some((saved) => saved.kind === 'pack' && saved.pack.bundleId === packBundleId)
      if (packBundleId && !isReferenced()) {
        try {
          const assets = await themeAssetsApi.list(packBundleId)
          if (isReferenced()) return
          await Promise.all(assets.map((a) => themeAssetsApi.delete(a.id).catch(() => {})))
        } catch {
          // Failed cleanup must not prevent removal from the library.
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
        name: entry.name,
        desktopBackground: entry.theme.desktopBackground ?? get().theme?.desktopBackground,
        renderingMode: entry.theme.renderingMode ?? get().theme?.renderingMode,
      }
      get().setTheme(theme)
    } else {
      const apply = (pack = entry.pack) => {
        get().applyThemePack({
          ...pack,
          components: entry.authoringSnapshot
            ? restoreThemePackComponents(pack.components, get().componentOverrides)
            : pack.components,
          globalCSSEnabled: entry.authoringSnapshot?.globalEnabled ?? pack.globalCSSEnabled,
          name: entry.name,
          theme: pack.theme ? { ...pack.theme, name: entry.name } : null,
        })
        if (entry.authoringSnapshot?.themeWasNull) get().setTheme(null)
      }
      if (!entry.authoringSnapshot || !entry.pack.assets.length) return apply()

      const before = get()
      const { theme, customCSS, componentOverrides } = before
      const bundleId = generateUUID()
      return uploadThemePackAssets(entry.pack.assets, bundleId, themeAssetsApi).then(async (uploaded) => {
        try {
          const current = get()
          if (current.savedThemes.find((saved) => saved.id === id) !== entry
            || current.theme !== theme || current.customCSS !== customCSS
            || current.componentOverrides !== componentOverrides) {
            throw new Error('Theme changed while restoring the backup. Try again.')
          }
          const pack = { ...entry.pack, bundleId }
          const savedThemes = current.savedThemes.map((saved) => saved.id === id ? { ...entry, pack } : saved)
          set({ savedThemes })
          persistKey('savedThemes', savedThemes)
          apply(pack)
        } catch (error) {
          await Promise.all(uploaded.map((asset) => themeAssetsApi.delete(asset.id).catch(() => {})))
          throw error
        }
      })
    }
  },

  updateSavedTheme: async (id) => {
    const state = get()
    const currentTheme = state.theme ?? DEFAULT_THEME
    const savedThemes = state.savedThemes.map((entry) => {
      if (entry.id !== id) return entry
      if (entry.kind === 'config') {
        return { ...entry, theme: { ...currentTheme, name: entry.name } } as typeof entry
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
        ...(entry.authoringSnapshot ? {
          authoringSnapshot: { version: 1 as const, globalEnabled: state.customCSS.enabled, themeWasNull: state.theme === null },
        } : {}),
        pack: {
          ...entry.pack,
          name: entry.name,
          theme: { ...currentTheme, name: entry.name },
          globalCSS: state.customCSS.css || '',
          globalCSSEnabled: state.customCSS.enabled,
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
    if (organizationWriter?.pending) deferredOrganizationReload = true
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
          || ((ORGANIZATION_KEYS as readonly string[]).includes(canonicalKey) && organizationWriter?.pending)
          || hasNewerLocalSetting(canonicalKey, localRevisionAtLoadStart)
          // Prefer a canonical setting row when both its legacy and current
          // names are present in the account.
          || (canonicalKey !== row.key && rows.some((candidate) => candidate.key === canonicalKey))
          // Drop values outside the ToastPosition union; the startup payload
          // validates identically so the two hydration paths cannot disagree.
          || (canonicalKey === 'toastPosition' && !isToastPosition(row.value))
          || !isValidSettingValue(canonicalKey, row.value)
        ) continue
        const storedValue = migrateStoredSettingValue(canonicalKey, row.value)
        if (canonicalKey === 'quickToolbarSettings' && !pendingValuesMatch(storedValue, row.value)) {
          migratedProductivityKeys.add(canonicalKey)
        }
        patch[canonicalKey] = mergeStoredSetting((defaults as any)[canonicalKey], storedValue, canonicalKey)
        if (canonicalKey !== row.key) legacySettingsToPersist[canonicalKey] = patch[canonicalKey]
      }

      // This preference was historically synced with the account. Seed each
      // device once from that committed backend row, then keep later changes
      // local so phones and desktops can choose different send-key behavior.
      const storedDeviceEnterToSend = readDeviceEnterToSend()
      const backendEnterToSend = rows.find((row) => row.key === 'inputBarEnterToSend')?.value
        ?? rows.find((row) => row.key === LEGACY_ENTER_TO_SEND_SETTING_KEY)?.value
      const migratedBackendSettings = parseEnterToSendSettings(backendEnterToSend) ?? {
        ...DEFAULT_ENTER_TO_SEND_SETTINGS,
        desktop: typeof backendEnterToSend === 'boolean'
          ? backendEnterToSend
          : DEFAULT_ENTER_TO_SEND_SETTINGS.desktop,
      }
      const deviceEnterToSend = typeof storedDeviceEnterToSend === 'boolean'
        ? {
            ...migratedBackendSettings,
            [isMobileViewportOrDevice() ? 'mobile' : 'desktop']: storedDeviceEnterToSend,
          }
        : storedDeviceEnterToSend ?? migratedBackendSettings
      persistDeviceEnterToSend(deviceEnterToSend)
      patch.inputBarEnterToSend = deviceEnterToSend

      // Recover any settings the previous page wrote to localStorage but may
      // not have persisted to the DB yet (keepalive flush races with this GET).
      const pendingKeys = readPendingSettings()
      if (pendingKeys) {
        for (const [k, v] of Object.entries(pendingKeys)) {
          if (
            !DATA_KEYS.has(k)
            || hasNewerLocalSetting(k, localRevisionAtLoadStart)
            || !isValidSettingValue(k, v)
          ) continue
          const pendingValue = migrateStoredSettingValue(k, v)
          if (k === 'quickToolbarSettings' && !pendingValuesMatch(pendingValue, v)) {
            migratedProductivityKeys.add(k)
          }
          patch[k] = mergeStoredSetting(patch[k] ?? (defaults as any)[k], pendingValue, k)
        }
      }

      // Accounts created before language persistence may have no language row.
      // Give them one stable app default instead of promoting a device-detected
      // cache. Preserve a Settings edit made while this GET was in flight.
      const initializeUiLanguage = !hasNewerLocalSetting('uiLanguage', localRevisionAtLoadStart)
        && !rows.some(row => row.key === 'uiLanguage' && isUiLanguage(row.value))
        && !isUiLanguage(pendingKeys?.uiLanguage)
      if (initializeUiLanguage) {
        patch.uiLanguage = defaults.uiLanguage ?? DEFAULT_UI_LANGUAGE
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
      if ('desktopPinchZoomEnabled' in patch) {
        patch.desktopPinchZoomEnabled = patch.desktopPinchZoomEnabled === true
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
          const activeImageGenConnectionId = savedConnectionId && profiles.some((profile) => profile.id === savedConnectionId)
            ? savedConnectionId
            : profiles.find((profile) => profile.is_default)?.id ?? null
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
        applyConnectionOrder(get(), patch.connectionsOrder as ConnectionsOrder, isCurrentLoad)
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
      if (initializeUiLanguage) persistKey('uiLanguage', get().uiLanguage, 'compatibility')
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
          if (!DATA_KEYS.has(key) || key === 'imageGeneration' || !isValidSettingValue(key, value)) continue
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
