import type {
  SpindleManifest,
  SpindleFrontendContext,
  SpindleFrontendModule,
  SpindleHostLocale,
  PermissionRequestOptions,
  SpindleMountPoint,
  SpindleTabLocation as TabLocation,
  SpindleFloatWidgetHandle,
  SpindleDockPanelHandle,
} from 'lumiverse-spindle-types'
import { SPINDLE_HOST_CAPABILITIES } from 'lumiverse-spindle-types'
import type { MacroCatalogResponse } from '@/api/macros'
import type {
  Chat,
  ChatSummary,
  ConnectionModelsResult,
  ConnectionProfile,
  GroupedRecentChat,
  Message,
  PaginatedResult,
  RecentChat,
  UpdateConnectionProfileInput,
  WorldBook,
  WorldBookEntry,
} from '@/types/api'
import type { SpindleCharacterEditorUI } from './character-editor-types'
import type { SpindleConnectionEditorUI } from './connection-editor-types'
import type { SpindlePresetEditorUI } from './preset-editor-types'
import { isKnownMountPoint, type WidenedMountPoint } from './mount-points'
import { createDOMHelper } from './dom-helper'
import { registerTagInterceptor, unregisterTagInterceptorsByExtension } from './message-interceptors'
import { registerDisplayResolver, unregisterDisplayResolver } from './display-resolver-registry'
import { invalidateDisplayRegexCacheForVars, invalidateDisplayRegexCache } from '@/hooks/useDisplayRegex'
import { removeMessageWidgetsByExtension, upsertMessageWidget, removeMessageWidget } from './message-widgets'
import {
  createDrawerTabHandle,
  createSettingsTabHandle,
  createCharacterEditorTabHandle,
  createConnectionEditorTabHandle,
  createPresetEditorTabHandle,
  createPresetEditorToolbarItemHandle,
  createFloatWidgetHandle,
  createDockPanelHandle,
  createAppMountHandle,
  createInputBarActionHandle,
  createTabMobilityHandle,
  clearTabMobilityHandle,
  destroyAllPlacementsForExtension,
  destroyPlacementsForExtensionPermission,
} from './placement-helper'
import {
  getCharacterEditorState,
  subscribeCharacterEditorState,
  setCharacterEditorExtensions,
  updateCharacterEditorExtensions,
  flushCharacterEditorExtensions,
} from './character-editor-helper'
import {
  getConnectionEditorState,
  getEditedConnectionProfileId,
  subscribeConnectionEditorState,
  subscribeConnectionEditorSaved,
} from './connection-editor-helper'
import {
  getPresetEditorState,
  subscribePresetEditorState,
  updatePresetEditorDraft,
  flushPresetEditorDraft,
} from './preset-editor-helper'
import { createPresetEditorAccess } from './preset-editor-access'
import {
  createComponentsHelper,
  destroyComponentsForTarget,
  destroyAllComponentsForExtension,
  destroyComponentsForExtensionPermission,
} from './components-helper'
import { generateUUID } from '@/lib/uuid'
import { installSpindleNavigationGuards } from './navigation-guards'
import { DRAWER_TABS, ensureRegistryRoot } from '@/lib/drawer-tab-registry'
import {
  createUIEventsHelper,
  destroyAllUIEventBindingsForExtension,
  destroyUIEventBindingsForExtensionPermission,
  type FrontendUIEventsHelper,
} from './ui-events-helper'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { charactersApi } from '@/api/characters'
import * as chatsApiModule from '@/api/chats'
import * as connectionsApiModule from '@/api/connections'
import * as worldBooksApiModule from '@/api/world-books'
import * as tokenizersApiModule from '@/api/tokenizers'
import { settingsApi } from '@/api/settings'
import { ApiError } from '@/api/client'
import i18n from 'i18next'
import { useStore } from '@/store'
import { yieldToBrowser } from './browser-scheduler'
import {
  createFrontendExtensionCleanup,
  finalizeFrontendLoadFailure,
  isPermissionBootstrapCurrent,
  observeFrontendSetupTeardown,
} from './frontend-extension-cleanup'
import {
  clearLiveRootsForExtension,
  registerLiveRoot,
} from './live-root-registry'
import {
  forgetExtensionIdentity,
  registerExtensionIdentity,
  stampExtensionRoot,
} from './extension-root-stamp'
import {
  createFrontendExtensionContext,
  createFrontendGeometryAPI,
  type FrontendContextAdditions,
  type FrontendDockPanelOptions,
  type FrontendFloatWidgetOptions,
} from './frontend-context'
import {
  THEME_AUTHORING_HOST_CAPABILITIES,
  type SpindleThemeAuthoringAPI,
} from './theme-authoring'
import { createNativeThemeAuthoringAPI } from './theme-authoring-native'
import { legacyCtxPermission } from './legacy-ctx-members'
import type { SpindleSettingsTabHandle, SpindleSettingsTabOptions } from './settings-tab-bridge'

export { createFrontendExtensionContext } from './frontend-context'
import { CORE_SETTING_KEYS } from './core-setting-keys'
import {
  createSettingsBridge,
  type SettingsUpdatedEvent,
  type SpindleSettingsAPI,
} from './settings-bridge'
import { createFrontendDomainApi } from './frontend-domain-api'
import { createStateSelectors, type StateSelectors } from './state-selectors'
import {
  canonicalFrontendAuthorityResolver,
  installFrontendAuthorityResolver,
  resolveFrontendAuthority,
} from './frontend-authority-seam'
import { frontendAuthorityRowFor } from './frontend-authority-map'
import { createHostSurfaceAPI, type HostSurfaceAPI } from './host-surfaces'
import './character-host-surface-renderers'
import './world-book-host-surface-renderers'
import './productivity-host-surface-renderers'
import {
  clearCssComponentsForExtension,
  registerCssComponent,
  type SpindleCssComponentRegistrationOptions,
} from './css-component-registry'
import {
  clearComponentOverridesForOwner,
  registerComponentOverride as registerSpindleComponentOverride,
  type SpindleComponentOverrideHandle,
  type SpindleComponentOverrideRegistrationInput,
} from './component-override-registry'
import {
  DATA_SPINDLE_MOUNT_ATTR,
  DATA_SPINDLE_SCOPE_ATTR,
  getDomDecoratorService,
  type DecoratorOptions,
} from './dom-decorator-service'
import { registerHostIntentHandler, type HostIntentHandler, type JsonValue } from './host-intent-registry'

declare const __APP_VERSION__: string

/** `__APP_VERSION__` is defined by Vite; the fallback keeps isolated tests portable. */
const LUMIVERSE_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

// Keep every production bridge leaf on the canonical P2 authority projection.
installFrontendAuthorityResolver(canonicalFrontendAuthorityResolver)

function getHostLocale(): SpindleHostLocale {
  const language = i18n.resolvedLanguage ?? i18n.language
  if (language === 'zh-TW' || language.toLowerCase().startsWith('zh-tw')) return 'zh-TW'
  if (language.startsWith('zh')) return 'zh'
  if (language.startsWith('ja')) return 'ja'
  if (language.startsWith('fr')) return 'fr'
  if (language.startsWith('it')) return 'it'
  return 'en'
}

function isMacroCatalogResponse(value: unknown): value is MacroCatalogResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('categories' in value) || !Array.isArray(value.categories)) {
    return false
  }
  return value.categories.every((category) => {
    if (!category || typeof category !== 'object' || Array.isArray(category) || !('category' in category) || typeof category.category !== 'string' || !('macros' in category) || !Array.isArray(category.macros)) {
      return false
    }
    return category.macros.every((macro) =>
      !!macro &&
      typeof macro === 'object' &&
      !Array.isArray(macro) &&
      'name' in macro &&
      typeof macro.name === 'string' &&
      'syntax' in macro &&
      typeof macro.syntax === 'string' &&
      'description' in macro &&
      typeof macro.description === 'string' &&
      'category' in macro &&
      typeof macro.category === 'string'
    )
  })
}

function isMacroCatalogResponseMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value)) return false
  return value.type === '__loom_macro_catalog_response'
}

function macroCatalogResponseRequestId(value: unknown): string | null {
  if (!isMacroCatalogResponseMessage(value) || typeof value !== 'object' || !('requestId' in value)) return null
  return typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId : null
}

function toSettingsUpdatedEvent(value: unknown): SettingsUpdatedEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.key !== undefined && typeof record.key !== 'string') return undefined
  if (record.keys !== undefined) {
    if (!Array.isArray(record.keys) || !record.keys.every((key) => typeof key === 'string')) return undefined
  }
  return {
    key: record.key as string | undefined,
    value: record.value,
    keys: record.keys as string[] | undefined,
  }
}

interface LoadedExtension {
  id: string
  generation: number
  identifier: string
  manifestSignature: string
  module: SpindleFrontendModule
  context: SpindleFrontendContext
  teardown?: () => void
  teardownClaimed: boolean
  staleTeardowns: Set<() => void>
  eventUnsubs: (() => void)[]
  deactivatePresetEditor(): void
  backendHandlers: Set<(payload: unknown) => void>
  macroCatalogHandlers: Map<string, (payload: unknown) => void>
  processHandlers: Map<string, FrontendProcessHandler>
  activeProcesses: Map<string, ActiveFrontendProcess>
  mountRoots: Element[]
  stopMountSync?: () => void
  isReady: boolean
  holdReady: boolean
  setupComplete: boolean
  readyTimeout: ReturnType<typeof setTimeout> | null
  cleanup(reportTeardownError?: boolean): void
}

type FrontendProcessHandler = (
  process: FrontendProcessContextLocal,
) => void | (() => void) | Promise<void | (() => void)>

interface FrontendProcessContextLocal {
  processId: string
  kind: string
  key?: string
  payload: unknown
  metadata?: Record<string, unknown>
  ready(): void
  heartbeat(): void
  send(payload: unknown): void
  onMessage(handler: (payload: unknown) => void): () => void
  complete(result?: unknown): void
  fail(error: string): void
  onStop(handler: (detail: { reason?: string }) => void): () => void
}

interface ActiveFrontendProcess {
  processId: string
  kind: string
  key?: string
  payload: unknown
  metadata?: Record<string, unknown>
  readySent: boolean
  terminal: boolean
  cleanup?: () => void | Promise<void>
  messageHandlers: Set<(payload: unknown) => void>
  stopHandlers: Set<(detail: { reason?: string }) => void>
}

type FrontendExtensionUI = Omit<SpindleFrontendContext['ui'], 'createFloatWidget' | 'requestDockPanel'> & {
  mount(point: WidenedMountPoint): Element
  getTabLocation(tabId: string): TabLocation
  registerSettingsTab(options: SpindleSettingsTabOptions): SpindleSettingsTabHandle
  createFloatWidget(options?: FrontendFloatWidgetOptions): SpindleFloatWidgetHandle
  requestDockPanel(options: FrontendDockPanelOptions): SpindleDockPanelHandle
  registerCssComponent(options: SpindleCssComponentRegistrationOptions): () => void
  registerComponentOverride(options: Omit<SpindleComponentOverrideRegistrationInput, 'owner' | 'generation'>): SpindleComponentOverrideHandle
  registerDomDecorator(options: Omit<DecoratorOptions, 'owner' | 'generation'>): () => void
  registerHostIntentHandler<T extends JsonValue = JsonValue>(name: string, handler: (detail: T) => boolean): () => void
}

type FrontendExtensionDOM = Omit<SpindleFrontendContext['dom'], 'addStyle'> & {
  addStyle(css: string, options?: { scope?: 'global' | 'root' }): () => void
}

type FrontendExtensionHost = {
  descriptorVersion: 1
  lumiverseVersion: string
  capabilities: Readonly<Record<string, number>>
  extensionInstallationId: string
  surfaces: HostSurfaceAPI
}

type FrontendExtensionContextBase = Omit<SpindleFrontendContext, 'ui' | 'messages' | 'dom'> & {
  host: FrontendExtensionHost
  theme: SpindleThemeAuthoringAPI
  dom: FrontendExtensionDOM
  ready(): void
  deferReady(): void
  ui: FrontendExtensionUI & SpindleCharacterEditorUI & SpindleConnectionEditorUI & SpindlePresetEditorUI & {
    events: FrontendUIEventsHelper
  }
  processes: {
    register(kind: string, handler: FrontendProcessHandler): () => void
  }
  messages: SpindleFrontendContext['messages'] & {
    renderWidget(
      options: { messageId: string; widgetId: string; html: string; minHeight?: number; maxHeight?: number },
      handler?: (payload: unknown) => void,
    ): () => void
    removeWidget(messageId: string, widgetId: string): void
  }
  settings: SpindleSettingsAPI
  characters: {
    get(characterId: string): Promise<unknown>
  }
}

export type FrontendExtensionContext = FrontendExtensionContextBase & FrontendContextAdditions

type FrontendProcessWirePayload =
  | {
      action: 'spawn'
      processId: string
      kind: string
      key?: string
      payload?: unknown
      metadata?: Record<string, unknown>
    }
  | {
      action: 'message'
      processId: string
      payload: unknown
    }
  | {
      action: 'stop'
      processId: string
      reason?: string
      force?: boolean
    }

type PendingStartupItem =
  | {
      generation: number
      kind: 'backend'
      payload: unknown
    }
  | {
      generation: number
      kind: 'process'
      payload: FrontendProcessWirePayload
    }

type PendingStartupPayload =
  | {
      kind: 'backend'
      payload: unknown
    }
  | {
      kind: 'process'
      payload: FrontendProcessWirePayload
    }

const loadedExtensions = new Map<string, LoadedExtension>()
const loadInFlight = new Map<string, {
  promise: Promise<void>
  force: boolean
  manifestSignature: string
  invalidated: boolean
}>()
const loadGeneration = new Map<string, number>()
const bootstrappingGenerations = new Map<string, number>()
const recentForceLoads = new Map<string, { manifestSignature: string; completedAt: number }>()
const FORCE_LOAD_DEDUPE_MS = 2000
const pendingStartupItems = new Map<string, PendingStartupItem[]>()
const pendingPermissionBootstraps = new Map<string, () => void>()
const MAX_PENDING_STARTUP_ITEMS = 100
const FRONTEND_READY_TIMEOUT_MS = 10_000
const FRONTEND_BUNDLE_TIMEOUT_MS = 15_000
const FRONTEND_MODULE_IMPORT_TIMEOUT_MS = 10_000
const extensionMountPoints = new Map<string, Set<WidenedMountPoint>>()
const extensionMountPointListeners = new Set<() => void>()
let extensionMountPointsVersion = 0
const warnedUnknownMountPoints = new Set<WidenedMountPoint>()

function notifyExtensionMountPointListeners(): void {
  extensionMountPointsVersion += 1
  for (const listener of extensionMountPointListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[Spindle] Extension mount-point listener error:', err)
    }
  }
}

function recordExtensionMountPoint(extensionId: string, point: WidenedMountPoint): void {
  const existing = extensionMountPoints.get(extensionId)
  if (existing?.has(point)) return

  const next = existing ? new Set(existing) : new Set<WidenedMountPoint>()
  next.add(point)
  extensionMountPoints.set(extensionId, next)
  notifyExtensionMountPointListeners()
}

function warnUnknownMountPoint(point: WidenedMountPoint): void {
  if (!import.meta.env.DEV || isKnownMountPoint(point) || warnedUnknownMountPoints.has(point)) return

  warnedUnknownMountPoints.add(point)
  console.warn(`[Spindle] Mount point "${point}" is not in the host mount-point catalog`)
}

function clearExtensionMountPoints(extensionId: string): void {
  if (!extensionMountPoints.delete(extensionId)) return
  notifyExtensionMountPointListeners()
}

function deliverBackendMessage(loaded: LoadedExtension, payload: unknown): void {
  if (isCurrentLoadedExtension(loaded) === false) return
  const macroRequestId = macroCatalogResponseRequestId(payload)
  if (isMacroCatalogResponseMessage(payload)) {
    if (!macroRequestId) return
    const handler = loaded.macroCatalogHandlers.get(macroRequestId)
    if (!handler) return
    try {
      handler(payload)
    } catch (err) {
      console.error(`[Spindle] Macro catalog response handler error for ${loaded.identifier}:`, err)
    }
    return
  }
  for (const handler of loaded.backendHandlers) {
    try {
      handler(payload)
    } catch (err) {
      console.error(`[Spindle] Backend message handler error for ${loaded.identifier}:`, err)
    }
  }
}

function isCurrentLoadedExtension(loaded: LoadedExtension): boolean {
  return loadedExtensions.get(loaded.id) === loaded && loadGeneration.get(loaded.id) === loaded.generation
}

function runProcessCleanupOnce(process: ActiveFrontendProcess): void {
  const cleanup = process.cleanup
  process.cleanup = undefined
  if (!cleanup) return
  try {
    void Promise.resolve(cleanup()).catch(() => {})
  } catch {
    // no-op
  }
}

function currentStartupGeneration(extensionId: string): number | null {
  const loaded = loadedExtensions.get(extensionId)
  if (loaded && !loaded.isReady && isCurrentLoadedExtension(loaded)) {
    return loaded.generation
  }
  const generation = bootstrappingGenerations.get(extensionId)
  if (generation !== undefined && loadGeneration.get(extensionId) === generation) {
    return generation
  }
  return null
}

function discardPendingStartupItems(extensionId: string, generation?: number): void {
  const items = pendingStartupItems.get(extensionId)
  if (!items) return
  if (generation === undefined) {
    pendingStartupItems.delete(extensionId)
    return
  }
  const remaining = items.filter((item) => item.generation !== generation)
  if (remaining.length > 0) pendingStartupItems.set(extensionId, remaining)
  else pendingStartupItems.delete(extensionId)
}

function queueStartupItem(extensionId: string, item: PendingStartupPayload): void {
  const generation = currentStartupGeneration(extensionId)
  if (generation === null) return
  const queue = pendingStartupItems.get(extensionId) ?? []
  queue.push({ ...item, generation })
  if (queue.length > MAX_PENDING_STARTUP_ITEMS) {
    queue.splice(0, queue.length - MAX_PENDING_STARTUP_ITEMS)
  }
  pendingStartupItems.set(extensionId, queue)
}


function clearReadyTimeout(loaded: LoadedExtension): void {
  if (loaded.readyTimeout) {
    clearTimeout(loaded.readyTimeout)
    loaded.readyTimeout = null
  }
}

function armReadyTimeout(loaded: LoadedExtension): void {
  if (loaded.readyTimeout || loaded.isReady || !isCurrentLoadedExtension(loaded)) return
  loaded.readyTimeout = setTimeout(() => {
    if (!isCurrentLoadedExtension(loaded) || loaded.isReady) return
    console.warn(
      `[Spindle] Frontend ready() timeout for ${loaded.identifier}; auto-releasing queued startup events`
    )
    markExtensionReady(loaded, 'timeout')
  }, FRONTEND_READY_TIMEOUT_MS)
}

function flushPendingStartupItems(loaded: LoadedExtension): number {
  const items = pendingStartupItems.get(loaded.id)
  if (!items?.length) return 0
  pendingStartupItems.delete(loaded.id)
  let replayed = 0
  for (const item of items) {
    if (item.generation !== loaded.generation) continue
    replayed += 1
    if (item.kind === 'backend') {
      deliverBackendMessage(loaded, item.payload)
    } else {
      deliverFrontendProcessEvent(loaded, item.payload)
    }
  }
  return replayed
}

function markExtensionReady(
  loaded: LoadedExtension,
  source: 'manual' | 'legacy-auto' | 'timeout'
): void {
  if (loaded.isReady || !isCurrentLoadedExtension(loaded)) return
  loaded.isReady = true
  if (bootstrappingGenerations.get(loaded.id) === loaded.generation) {
    bootstrappingGenerations.delete(loaded.id)
  }
  clearReadyTimeout(loaded)
  const replayed = flushPendingStartupItems(loaded)
  if (useStore.getState().spindleSettings.infoLoggingEnabled) {
    console.debug(
      `[Spindle] Frontend ready (${source}): ${loaded.identifier}${replayed > 0 ? ` [replayed ${replayed}]` : ''}`
    )
  }
}

function getManifestSignature(manifest: SpindleManifest): string {
  return `${manifest.identifier}:${manifest.version}:${manifest.entry_frontend || 'dist/frontend.js'}`
}

function getFrontendBundleUrl(extensionId: string, manifest: SpindleManifest): string {
  const cacheKey = (manifest as SpindleManifest & { frontend_cache_key?: unknown }).frontend_cache_key
  const version = typeof cacheKey === 'string' && cacheKey.trim()
    ? cacheKey
    : getManifestSignature(manifest)
  return `/api/v1/spindle/${extensionId}/frontend?v=${encodeURIComponent(version)}`
}

function frontendLoadTimeout(identifier: string, phase: string, timeoutMs: number): Error {
  return new Error(
    `SPINDLE_FRONTEND_TIMEOUT: ${identifier} ${phase} exceeded ${timeoutMs}ms`,
  )
}

async function importFrontendModule(
  blobUrl: string,
  identifier: string,
): Promise<SpindleFrontendModule> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      import(/* @vite-ignore */ blobUrl) as Promise<SpindleFrontendModule>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(frontendLoadTimeout(identifier, 'module evaluation', FRONTEND_MODULE_IMPORT_TIMEOUT_MS))
        }, FRONTEND_MODULE_IMPORT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}


async function doLoadFrontendExtension(
  extensionId: string,
  manifest: SpindleManifest,
  force = false
): Promise<void> {
  let loaded!: LoadedExtension
  let cleanupLoadedExtension: ((reportTeardownError?: boolean) => void) | undefined
  let identityRegistered = false
  const manifestSignature = getManifestSignature(manifest)
  const existing = loadedExtensions.get(extensionId)

  if (!force && existing?.manifestSignature === manifestSignature) {
    return
  }

  if (existing) {
    await unloadFrontendExtension(extensionId)
  }

  const generation = (loadGeneration.get(extensionId) || 0) + 1
  bootstrappingGenerations.set(extensionId, generation)
  loadGeneration.set(extensionId, generation)
  let frontendLifecycleActive = true
  const currentGeneration = () => loadGeneration.get(extensionId) === generation
  const assertFrontendActive = () => {
    if (
      frontendLifecycleActive === false
      || currentGeneration() === false
      || (loaded && loadedExtensions.get(extensionId) !== loaded)
    ) {
      throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
    }
  }
  const assertLegacyPermission = (member: string) => {
    assertFrontendActive()
    const permission = legacyCtxPermission(member)
    if (permission.split('|').some((candidate) => cachedGrantedPermissions.includes(candidate))) return
    throw new Error(`PERMISSION_DENIED:${permission} — ${member} requires the ${permission} permission`)
  }
  const assertCanonicalPermission = (permission: string, member: string) => {
    assertFrontendActive()
    const row = frontendAuthorityRowFor({ surface: 'ctx_member', id: member })
      ?? frontendAuthorityRowFor({ surface: 'legacy_ctx_member', id: member })
    if (!row) throw new Error(`FRONTEND_AUTHORITY_UNKNOWN:${member}`)
    if (row.permission !== permission) {
      throw new Error(`FRONTEND_AUTHORITY_PERMISSION_MISMATCH:${member}`)
    }
    if (permission.split('|').some((candidate) => cachedGrantedPermissions.includes(candidate))) return
    throw new Error(`PERMISSION_DENIED:${permission} - ${member} requires the ${permission} permission`)
  }
  const bundleUrl = getFrontendBundleUrl(extensionId, manifest)
  const decoratorService = getDomDecoratorService({ extensionId, generation })
  const unloadDomDecorators = () => {
    decoratorService.unloadGeneration(extensionId, generation)
    decoratorService.flush()
  }
  const eventUnsubs: (() => void)[] = []
  const trackEventUnsubscribe = (unsubscribe: () => void): (() => void) => {
    let active = true
    const tracked = () => {
      if (!active) return
      active = false
      const index = eventUnsubs.indexOf(tracked)
      if (index !== -1) eventUnsubs.splice(index, 1)
      unsubscribe()
    }
    eventUnsubs.push(tracked)
    return tracked
  }
  let stateSelectors: StateSelectors | undefined
  let cachedGrantedPermissions: string[] = []
  const settingsBridge = createSettingsBridge({
    manifestIdentifier: manifest.identifier,
    coreSettingKeys: CORE_SETTING_KEYS,
    core: {
      get: (key) => (useStore.getState() as unknown as Record<string, unknown>)[key],
      subscribe(key, handler) {
        let previous = (useStore.getState() as unknown as Record<string, unknown>)[key]
        return useStore.subscribe((state) => {
          const next = (state as unknown as Record<string, unknown>)[key]
          if (Object.is(previous, next)) return
          previous = next
          handler(next)
        })
      },
      isReady: () => Boolean((useStore.getState() as unknown as { fullSettingsLoaded?: boolean }).fullSettingsLoaded),
    },
    persistence: {
      async get(key) {
        try {
          return await settingsApi.get(key)
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return undefined
          throw error
        }
      },
      set: (key, value) => settingsApi.put(key, value),
      remove: (key) => settingsApi.delete(key),
    },
    hasPermission: (permission) => cachedGrantedPermissions.includes(permission),
    onSettingsUpdated: (handler) => wsClient.on('SETTINGS_UPDATED', (payload: unknown) => {
      const event = toSettingsUpdatedEvent(payload)
      if (event) handler(event)
    }),
    window,
  })
  const settings: SpindleSettingsAPI = {
    get: settingsBridge.get,
    set: settingsBridge.set,
    remove: settingsBridge.remove,
    watch: settingsBridge.watch,
    core: settingsBridge.core,
  }
  eventUnsubs.push(() => settingsBridge.dispose())
  let permissionEventVersion = 0
  let presetEditorActive = true
  let presetEditorAccessRevoked = false
  const presetEditorUnsubscribers = new Set<() => void>()
  const characterEditorUnsubscribers = new Set<() => void>()
  const connectionEditorUnsubscribers = new Set<() => void>()
  const trackPresetEditorSubscription = (unsubscribe: () => void): (() => void) => {
    const tracked = () => {
      if (!presetEditorUnsubscribers.delete(tracked)) return
      unsubscribe()
    }
    presetEditorUnsubscribers.add(tracked)
    return tracked
  }
  const clearPresetEditorSubscriptions = () => {
    for (const unsubscribe of [...presetEditorUnsubscribers]) {
      try { unsubscribe() } catch { /* no-op */ }
    }
  }
  const trackCharacterEditorSubscription = (unsubscribe: () => void): (() => void) => {
    let active = true
    const tracked = () => {
      if (!active) return
      active = false
      characterEditorUnsubscribers.delete(tracked)
      try { unsubscribe() } catch { /* no-op */ }
    }
    characterEditorUnsubscribers.add(tracked)
    return tracked
  }
  const clearCharacterEditorSubscriptions = () => {
    for (const unsubscribe of [...characterEditorUnsubscribers]) {
      unsubscribe()
    }
  }
  const trackConnectionEditorSubscription = (unsubscribe: () => void): (() => void) => {
    let active = true
    const tracked = () => {
      if (!active) return
      active = false
      connectionEditorUnsubscribers.delete(tracked)
      try { unsubscribe() } catch { /* no-op */ }
    }
    connectionEditorUnsubscribers.add(tracked)
    return tracked
  }
  const clearConnectionEditorSubscriptions = () => {
    for (const unsubscribe of [...connectionEditorUnsubscribers]) {
      unsubscribe()
    }
  }
  let scopedPresetAccess = createPresetEditorAccess(
    manifest.identifier,
    () => cachedGrantedPermissions,
    trackPresetEditorSubscription,
  )
  const revokePresetEditorAccess = () => {
    if (presetEditorAccessRevoked) return
    presetEditorAccessRevoked = true
    scopedPresetAccess.dispose()
    clearPresetEditorSubscriptions()
  }
  const restorePresetEditorAccess = () => {
    if (!presetEditorAccessRevoked) return
    scopedPresetAccess = createPresetEditorAccess(
      manifest.identifier,
      () => cachedGrantedPermissions,
      trackPresetEditorSubscription,
    )
    presetEditorAccessRevoked = false
  }
  const assertPresetPermission = (member = 'ctx.ui.presetEditor.getState') => {
    assertFrontendActive()
    if (!presetEditorActive) {
      throw new Error('PRESET_EDITOR_DISPOSED: Extension frontend has been unloaded')
    }
    assertLegacyPermission(member)
  }
  const destroyRevokedResources = (previous: readonly string[], next: readonly string[]) => {
    const revokedPermissions = previous.filter((permission) => !next.includes(permission))
    if (revokedPermissions.length > 0) {
      clearCssComponentsForExtension(extensionId, generation)
      clearComponentOverridesForOwner(extensionId, generation)
    }
    stateSelectors?.revokePermissions(revokedPermissions)
    if (previous.includes('world_books') && !next.includes('world_books')) {
      destroyComponentsForExtensionPermission(extensionId, 'world_books', generation)
    }
    const resourcePermissions = ['characters', 'ui_panels', 'app_manipulation', 'presets', 'generation'] as const
    for (const permission of resourcePermissions) {
      if (previous.includes(permission) && !next.includes(permission)) {
        if (permission === 'characters') clearCharacterEditorSubscriptions()
        if (permission === 'generation') clearConnectionEditorSubscriptions()
        if (permission === 'generation') {
          destroyPlacementsForExtensionPermission(extensionId, permission, generation)
          continue
        }
        destroyComponentsForExtensionPermission(extensionId, permission, generation)
        destroyPlacementsForExtensionPermission(extensionId, permission, generation)
        destroyUIEventBindingsForExtensionPermission(extensionId, permission)
      }
    }
  }
  let permissionBootstrapCleaned = false
  const cleanupPermissionBootstrap = () => {
    if (permissionBootstrapCleaned) return
    permissionBootstrapCleaned = true
    discardPendingStartupItems(extensionId, generation)
    if (bootstrappingGenerations.get(extensionId) === generation) {
      bootstrappingGenerations.delete(extensionId)
    }
    if (pendingPermissionBootstraps.get(extensionId) === cleanupPermissionBootstrap) {
      pendingPermissionBootstraps.delete(extensionId)
    }
    while (eventUnsubs.length > 0) {
      const unsubs = eventUnsubs.splice(0)
      for (const unsubscribe of unsubs) {
        try {
          unsubscribe()
        } catch {
          // no-op
        }
      }
    }
    clearCssComponentsForExtension(extensionId, generation)
    clearComponentOverridesForOwner(extensionId, generation)
    unloadDomDecorators()
    try {
      clearPresetEditorSubscriptions()
      clearCharacterEditorSubscriptions()
      clearConnectionEditorSubscriptions()
    } catch {
      // no-op
    }
    scopedPresetAccess.dispose()
  }
  pendingPermissionBootstraps.set(extensionId, cleanupPermissionBootstrap)
  const unsubPermissionSync = wsClient.on('SPINDLE_PERMISSION_CHANGED', (payload: unknown) => {
    if (!frontendLifecycleActive || !currentGeneration() || (loaded && loadedExtensions.get(extensionId) !== loaded)) return
    if (typeof payload !== 'object' || payload === null || !('extensionId' in payload) || !('allGranted' in payload)) return
    const payloadExtensionId = payload.extensionId
    const allGrantedValue = payload.allGranted
    if (
      payloadExtensionId !== extensionId
      || !Array.isArray(allGrantedValue)
      || !allGrantedValue.every((permission): permission is string => typeof permission === 'string')
    ) return
    permissionEventVersion += 1
    const previousGrantedPermissions = cachedGrantedPermissions
    cachedGrantedPermissions = allGrantedValue
    destroyRevokedResources(previousGrantedPermissions, cachedGrantedPermissions)
    if (cachedGrantedPermissions.includes('presets')) {
      restorePresetEditorAccess()
    } else {
      revokePresetEditorAccess()
    }
  })
  eventUnsubs.push(unsubPermissionSync)

  try {
    const bundleAbort = new AbortController()
    const bundleTimeout = setTimeout(() => {
      bundleAbort.abort(
        frontendLoadTimeout(manifest.identifier, 'bundle retrieval', FRONTEND_BUNDLE_TIMEOUT_MS),
      )
    }, FRONTEND_BUNDLE_TIMEOUT_MS)
    const responsePromise = fetch(bundleUrl, { signal: bundleAbort.signal })
    const permissionReadVersion = permissionEventVersion
    const permissionsPromise = spindleApi.getPermissions(extensionId)
      .then((permRes) => permRes.granted)
      .catch(() => [] as string[])
    installSpindleNavigationGuards()

    let blob: Blob
    try {
      const response = await responsePromise
      if (!response.ok) {
        cleanupPermissionBootstrap()
        return // No frontend bundle
      }
      blob = await response.blob()
    } catch (error) {
      if (bundleAbort.signal.aborted) {
        throw frontendLoadTimeout(
          manifest.identifier,
          'bundle retrieval',
          FRONTEND_BUNDLE_TIMEOUT_MS,
        )
      }
      throw error
    } finally {
      clearTimeout(bundleTimeout)
    }
    const blobUrl = URL.createObjectURL(blob)
    let mod!: SpindleFrontendModule
    try {
      if (currentGeneration()) {
        await yieldToBrowser({ when: 'paint' })
        if (currentGeneration()) {
          mod = await importFrontendModule(blobUrl, manifest.identifier)
        }
      }
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    if (!currentGeneration()) {
      cleanupPermissionBootstrap()
      return
    }

    // Frontend extensions still execute in the Lumiverse document context so
    // existing UI roots remain fully interactive. Scriptable iframe content must
    // opt into ctx.dom.createSandboxFrame() instead of replacing the base UI path.

    if (typeof mod.setup !== 'function') {
      console.warn(`[Spindle:${manifest.identifier}] Frontend module missing setup()`)
      cleanupPermissionBootstrap()
      return
    }

    const backendHandlers = new Set<(payload: unknown) => void>()
    const macroCatalogHandlers = new Map<string, (payload: unknown) => void>()
    const pendingMacroCatalogCancellers = new Set<() => void>()
    const pendingCorsProxyCancellers = new Set<() => void>()
    const processHandlers = new Map<string, FrontendProcessHandler>()
    const activeProcesses = new Map<string, ActiveFrontendProcess>()
    const mountRoots = new Map<WidenedMountPoint, Element>()
    const mountRootUnregisters = new Map<Element, () => void>()
    const modalDisposers = new Set<() => void>()
    const pendingFilePickerCleanups = new Set<() => void>()
    const contextTeardownHandlers = new Set<() => void>()

    const getMacroCatalogForExtension = (): Promise<MacroCatalogResponse> => {
      if (!currentGeneration() || (loaded && !isCurrentLoadedExtension(loaded))) {
        return Promise.reject(new Error('Macro catalog request cancelled'))
      }
      const requestId = generateUUID()
      const { promise, resolve, reject } = Promise.withResolvers<MacroCatalogResponse>()
      let settled = false
      const finish = () => {
        clearTimeout(timeout)
        macroCatalogHandlers.delete(requestId)
        pendingMacroCatalogCancellers.delete(cancel)
      }
      const cancel = () => {
        if (settled) return
        settled = true
        finish()
        reject(new Error('Macro catalog request cancelled'))
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        finish()
        reject(new Error('Macro catalog request timed out'))
      }, 30_000)
      const handler = (payload: unknown) => {
        if (macroCatalogResponseRequestId(payload) !== requestId) return
        if (settled) return
        if (!currentGeneration() || (loaded && !isCurrentLoadedExtension(loaded))) {
          cancel()
          return
        }
        settled = true
        finish()
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          reject(new Error('Invalid macro catalog response'))
          return
        }
        if ('error' in payload && typeof payload.error === 'string' && payload.error.length > 0) {
          reject(new Error(payload.error))
          return
        }
        if (!('catalog' in payload) || !isMacroCatalogResponse(payload.catalog)) {
          reject(new Error('Invalid macro catalog response'))
          return
        }
        resolve(payload.catalog)
      }
      pendingMacroCatalogCancellers.add(cancel)
      macroCatalogHandlers.set(requestId, handler)
      try {
        wsClient.send({
          type: 'SPINDLE_BACKEND_MSG',
          extensionId,
          payload: {
            type: '__loom_macro_catalog_request',
            requestId,
          },
        })
      } catch (error) {
        if (!settled) {
          settled = true
          finish()
          reject(error)
        }
      }
      return promise
    }

    const corsProxy = (url: string, options?: any): Promise<any> => {
      assertFrontendActive()
      return new Promise((resolve, reject) => {
        const requestId = generateUUID()
        let settled = false
        const finish = () => {
          clearTimeout(timeout)
          backendHandlers.delete(handler)
          pendingCorsProxyCancellers.delete(cancel)
        }
        const cancel = () => {
          if (settled) return
          settled = true
          finish()
          reject(new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active'))
        }
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          finish()
          reject(new Error('CORS proxy request timed out'))
        }, 30_000)

        const handler = (payload: unknown) => {
          if (
            frontendLifecycleActive === false
            || currentGeneration() === false
            || (loaded && loadedExtensions.get(extensionId) !== loaded)
          ) {
            cancel()
            return
          }
          if (typeof payload !== 'object' || payload === null) return
          const p = payload as any
          if (p.type !== '__cors_proxy_response' || p.requestId !== requestId) return

          if (settled) return
          settled = true
          finish()

          if (p.error) {
            reject(new Error(p.error))
          } else {
            const result = p.result
            if (result?.encoding === 'base64' && typeof result.body === 'string') {
              const binaryString = atob(result.body)
              const bytes = new Uint8Array(binaryString.length)
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }
              resolve({ ...result, body: bytes })
            } else {
              resolve(result)
            }
          }
        }

        pendingCorsProxyCancellers.add(cancel)
        backendHandlers.add(handler)
        try {
          assertFrontendActive()
          wsClient.send({
            type: 'SPINDLE_BACKEND_MSG',
            extensionId,
            payload: {
              type: '__cors_proxy_request',
              requestId,
              url,
              options,
            },
          })
        } catch (error) {
          if (settled) return
          settled = true
          finish()
          reject(error)
        }
      })
    }

    registerExtensionIdentity(extensionId, manifest.identifier)
    identityRegistered = true
    const dom = createDOMHelper(
      extensionId,
      manifest.identifier,
      corsProxy,
      () => cachedGrantedPermissions.includes('unsafe_eval'),
      assertFrontendActive,
      generation,
    )
    const uiEvents = createUIEventsHelper(extensionId, assertFrontendActive, generation)
    const trackUIEventSubscription = (unsubscribe: () => void): (() => void) => {
      let active = true
      const tracked = () => {
        if (!active) return
        active = false
        unsubscribe()
        const index = eventUnsubs.indexOf(tracked)
        if (index !== -1) eventUnsubs.splice(index, 1)
      }
      eventUnsubs.push(tracked)
      return tracked
    }
    const scopedUIEvents: FrontendUIEventsHelper = {
      getKeyboardState() {
        assertFrontendActive()
        return uiEvents.getKeyboardState()
      },
      onKeyboardChange: (handler) => trackUIEventSubscription(uiEvents.onKeyboardChange(handler)),
      getDrawerState() {
        assertFrontendActive()
        return uiEvents.getDrawerState()
      },
      onDrawerChange: (handler) => trackUIEventSubscription(uiEvents.onDrawerChange(handler)),
      getSettingsState() {
        assertFrontendActive()
        return uiEvents.getSettingsState()
      },
      onSettingsChange: (handler) => trackUIEventSubscription(uiEvents.onSettingsChange(handler)),
      getModalState() {
        assertFrontendActive()
        return uiEvents.getModalState()
      },
      onModalChange: (handler) => trackUIEventSubscription(uiEvents.onModalChange(handler)),
      bindActionHandlers: (target, handlers, options) =>
        uiEvents.bindActionHandlers(target, handlers, options),
    }

    const initialPermissions = await permissionsPromise
    if (isPermissionBootstrapCurrent(permissionReadVersion, permissionEventVersion)) {
      cachedGrantedPermissions = initialPermissions
    }
    if (!currentGeneration()) {
      cleanupPermissionBootstrap()
      return
    }
    const onTeardown = (handler: () => void): (() => void) => {
      assertFrontendActive()
      let active = true
      const tracked = () => {
        if (!active) return
        active = false
        const index = eventUnsubs.indexOf(tracked)
        if (index !== -1) eventUnsubs.splice(index, 1)
        handler()
      }
      eventUnsubs.push(tracked)
      return () => {
        if (!active) return
        active = false
        const index = eventUnsubs.indexOf(tracked)
        if (index !== -1) eventUnsubs.splice(index, 1)
      }
    }
    // Keep isolated loader harnesses compatible with partial API namespaces.
    const runtimeMessagesApi = {
      list: chatsApiModule.messagesApi?.list ?? (async (
        _chatId: string,
        options?: { limit?: number; tail?: boolean },
      ): Promise<PaginatedResult<Message>> => ({
        data: [],
        total: 0,
        limit: options?.limit ?? 200,
        offset: 0,
      })),
      update: chatsApiModule.messagesApi?.update ?? (async (
        _chatId: string,
        messageId: string,
        input: { content?: string },
      ) => ({ id: messageId, content: input.content ?? null } as unknown as Message)),
    }
    const runtimeChatsApi = {
      listCharacterChats: chatsApiModule.chatsApi?.listCharacterChats
        ?? (async (_characterId: string): Promise<ChatSummary[]> => []),
      listRecent: chatsApiModule.chatsApi?.listRecent
        ?? (async (_options?: { limit?: number; offset?: number; search?: string; sort?: 'name' | 'recent' | 'created'; direction?: 'asc' | 'desc' }): Promise<PaginatedResult<RecentChat>> => ({ data: [], total: 0 } as PaginatedResult<RecentChat>)),
      listRecentGrouped: chatsApiModule.chatsApi?.listRecentGrouped
        ?? (async (_options?: { limit?: number; offset?: number; search?: string; sort?: 'name' | 'recent' | 'created'; direction?: 'asc' | 'desc' }): Promise<PaginatedResult<GroupedRecentChat>> => ({ data: [], total: 0 } as PaginatedResult<GroupedRecentChat>)),
      update: chatsApiModule.chatsApi?.update
        ?? (async (_id: string, _input: Partial<{ name: string; metadata: Record<string, unknown> }>): Promise<Chat> => ({ } as Chat)),
      delete: chatsApiModule.chatsApi?.delete
        ?? (async (_id: string): Promise<void> => undefined),
    }
    const runtimeConnectionsApi = {
      models: connectionsApiModule.connectionsApi?.models
        ?? (async (_id: string): Promise<ConnectionModelsResult> => ({ models: [], provider: '' })),
      update: connectionsApiModule.connectionsApi?.update
        ?? (async (_id: string, _input: UpdateConnectionProfileInput): Promise<ConnectionProfile> => ({ } as ConnectionProfile)),
    }
    const runtimeWorldBooksApi = {
      list: worldBooksApiModule.worldBooksApi?.list
        ?? (async (): Promise<WorldBook[]> => []),
      listEntries: worldBooksApiModule.worldBooksApi?.listEntries
        ?? (async (): Promise<WorldBookEntry[]> => []),
      listAll: worldBooksApiModule.worldBooksApi?.listAll
        ?? (async (): Promise<WorldBook[]> => []),
      listAllEntries: worldBooksApiModule.worldBooksApi?.listAllEntries
        ?? (async (): Promise<WorldBookEntry[]> => []),
    }
    const runtimeTokenizersApi = tokenizersApiModule.tokenizersApi ?? {
      countForModel: async () => ({}),
      countForModelBatch: async () => ({ results: [] }),
    }

    const resolveFrontendTokenModel = (options?: { model?: string; modelSource?: 'main' | 'sidecar' }): string => {
      const explicit = options?.model?.trim()
      if (explicit) return explicit
      if (options?.modelSource === 'sidecar') {
        throw new Error('TOKEN_MODEL_REQUIRED: sidecar token counting requires an explicit model')
      }
      const state = useStore.getState()
      const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId)
      const model = activeProfile?.model?.trim()
      if (!model) throw new Error('TOKEN_MODEL_REQUIRED: no active model is configured')
      return model
    }


    const stateSelectorBridge = createStateSelectors({
      assertActive: assertFrontendActive,
      resolveAuthority: resolveFrontendAuthority,
      grantedPermissions: () => cachedGrantedPermissions,
      onTeardown,
      settingIds: CORE_SETTING_KEYS.map((entry) => entry.key),
    })
    stateSelectors = stateSelectorBridge
    const domain = createFrontendDomainApi({
      store: useStore,
      assertActive: assertFrontendActive,
      requirePermission(permission, member) {
        assertCanonicalPermission(permission, member)
        if (!cachedGrantedPermissions.includes(permission)) {
          throw new Error(`PERMISSION_DENIED:${permission} — ${member} requires the ${permission} permission`)
        }
      },
      onTeardown,
      connections: {
        models: runtimeConnectionsApi.models,
        update: runtimeConnectionsApi.update,
      },
      chats: {
        listForCharacter: runtimeChatsApi.listCharacterChats,
        getMessages: runtimeMessagesApi.list,
        listRecent: runtimeChatsApi.listRecent,
        listRecentGrouped: runtimeChatsApi.listRecentGrouped,
        update: runtimeChatsApi.update,
        delete: runtimeChatsApi.delete,
      },
      worldBooks: {
        list: runtimeWorldBooksApi.listAll,
        entries: runtimeWorldBooksApi.listAllEntries,
      },
      tokens: {
        countText: (text, options) => runtimeTokenizersApi.countForModel(resolveFrontendTokenModel(options), text),
        countTextBatch: async (texts, options) => {
          const response = await runtimeTokenizersApi.countForModelBatch(resolveFrontendTokenModel(options), [...texts])
          return response.results
        },
      },
    })
    const mountedPoints = new Set<WidenedMountPoint>()
    let openModalCount = 0
    const pendingPermissionCleanups = new Set<() => void>()
    const pendingContextMenuCleanups = new Set<() => void>()
    const pendingConfirmCleanups = new Set<() => void>()

    let mountSyncActive = true
    let mountRetryTimer: ReturnType<typeof setTimeout> | null = null
    const registeredDecoratorAnchors = new Set<Element>()
    const attachMountRoots = () => {
      if (!mountSyncActive) return
      if (document.body.hasAttribute('data-chat-chrome-entering')) {
        if (mountRetryTimer === null) {
          mountRetryTimer = setTimeout(() => {
            mountRetryTimer = null
            attachMountRoots()
          }, 50)
        }
        return
      }
      for (const [point, root] of mountRoots) {
        const selector = `[data-spindle-mount="${point}"]`
        const target = document.querySelector(selector)
        if (!target) continue
        if (root.parentElement !== target) {
          target.appendChild(root)
        }
      }
      for (const node of [...registeredDecoratorAnchors]) {
        if (node.isConnected) continue
        decoratorService.unregisterAnchor(node)
        registeredDecoratorAnchors.delete(node)
      }
      const hosts = document.querySelectorAll(`[${DATA_SPINDLE_MOUNT_ATTR}][${DATA_SPINDLE_SCOPE_ATTR}]`)
      for (const host of hosts) {
        const mount = host.getAttribute(DATA_SPINDLE_MOUNT_ATTR)
        const scope = host.getAttribute(DATA_SPINDLE_SCOPE_ATTR)
        if (!mount || !scope?.trim()) continue
        decoratorService.registerAnchor({
          mount,
          scope,
          owner: extensionId,
          generation,
          node: host,
        })
        registeredDecoratorAnchors.add(host)
      }
    }

    const mountObserver = new MutationObserver(() => {
      attachMountRoots()
    })
    mountObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [DATA_SPINDLE_MOUNT_ATTR, DATA_SPINDLE_SCOPE_ATTR],
    })
    attachMountRoots()

    const cleanupMountInfra = () => {
      mountSyncActive = false
      if (mountRetryTimer !== null) {
        clearTimeout(mountRetryTimer)
        mountRetryTimer = null
      }
      mountObserver.disconnect()
      unloadDomDecorators()
      registeredDecoratorAnchors.clear()
      for (const dismiss of [...modalDisposers]) {
        try { dismiss() } catch { /* no-op */ }
      }
      for (const [root, unregisterRoot] of mountRootUnregisters) {
        unregisterRoot()
        try {
          root.remove()
        } catch {
          // no-op
        }
      }
      mountRootUnregisters.clear()
      mountRoots.clear()
      mountedPoints.clear()
      clearExtensionMountPoints(extensionId)
    }

    const host = Object.freeze({
      descriptorVersion: 1 as const,
      lumiverseVersion: LUMIVERSE_VERSION,
      capabilities: Object.freeze({ ...SPINDLE_HOST_CAPABILITIES, ...THEME_AUTHORING_HOST_CAPABILITIES }),
      extensionInstallationId: extensionId,
      surfaces: createHostSurfaceAPI({
        extensionId,
        getGrantedPermissions: () => cachedGrantedPermissions,
        assertActive: assertFrontendActive,
        onTeardown,
      }),
    })
    const locale = {
      get(): SpindleHostLocale {
        assertFrontendActive()
        return getHostLocale()
      },
      subscribe(listener: (nextLocale: SpindleHostLocale) => void): () => void {
        assertFrontendActive()
        let active = true
        const notify = () => {
          if (!active) return
          try {
            listener(getHostLocale())
          } catch (error) {
            console.error(`[Spindle:${manifest.identifier}] Locale listener error:`, error)
          }
        }
        i18n.on('languageChanged', notify)
        const unsubscribe = () => {
          if (!active) return
          active = false
          i18n.off('languageChanged', notify)
          const index = eventUnsubs.indexOf(unsubscribe)
          if (index !== -1) eventUnsubs.splice(index, 1)
        }
        eventUnsubs.push(unsubscribe)
        return unsubscribe
      },
    }

    const baseContext: FrontendExtensionContextBase = {
      host,
      theme: createNativeThemeAuthoringAPI(
        assertFrontendActive,
        (member) => assertCanonicalPermission('app_manipulation', member),
      ),
      locale,
      dom,
      ready() {
        assertFrontendActive()
        markExtensionReady(loaded, 'manual')
      },
      deferReady() {
        assertFrontendActive()
        if (loaded.isReady) {
          console.warn(`[Spindle:${manifest.identifier}] deferReady() called after frontend was already ready`)
          return
        }
        if (loaded.setupComplete) {
          console.warn(`[Spindle:${manifest.identifier}] deferReady() must be called before setup() returns`)
          return
        }
        if (!loaded.holdReady) {
          loaded.holdReady = true
          armReadyTimeout(loaded)
        }
      },
      events: {
        on(event: string, handler: (payload: unknown) => void): () => void {
          assertFrontendActive()
          let active = true
          const windowEventName = `spindle:${event}`
          const windowHandler = (eventObject: Event) => {
            if (!active) return
            handler((eventObject as CustomEvent).detail)
          }
          const wsUnsubscribe = wsClient.on(event, handler)
          window.addEventListener(windowEventName, windowHandler)
          const unsubscribe = () => {
            if (!active) return
            active = false
            wsUnsubscribe()
            window.removeEventListener(windowEventName, windowHandler)
            const idx = eventUnsubs.indexOf(unsubscribe)
            if (idx !== -1) eventUnsubs.splice(idx, 1)
          }
          eventUnsubs.push(unsubscribe)
          return () => {
            unsubscribe()
          }
        },
        emit(event: string, payload: unknown): void {
          assertFrontendActive()
          // Frontend-only events — extensions can use this for inter-extension communication
          window.dispatchEvent(
            new CustomEvent(`spindle:${event}`, { detail: payload })
          )
        },
      },
      ui: {
        events: scopedUIEvents,
        mount(point: WidenedMountPoint) {
          assertFrontendActive()
          warnUnknownMountPoint(point)
          let root = mountRoots.get(point)
          if (!root) {
            root = document.createElement('div')
            stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
            root.setAttribute('data-spindle-mount-point', point)
            mountRootUnregisters.set(root, registerLiveRoot(extensionId, root, null, generation))
            mountRoots.set(point, root)
          }
          recordExtensionMountPoint(extensionId, point)
          if (!mountedPoints.has(point)) {
            root.replaceChildren()
            mountedPoints.add(point)
          }
          attachMountRoots()
          return root
        },
        registerDrawerTab(options) {
          assertFrontendActive()
          return createDrawerTabHandle(extensionId, options, assertFrontendActive, generation)
        },
        registerSettingsTab(options) {
          assertFrontendActive()
          return createSettingsTabHandle(extensionId, options, assertFrontendActive, generation)
        },
        registerCharacterEditorTab(options) {
          assertLegacyPermission('ctx.ui.registerCharacterEditorTab')
          return createCharacterEditorTabHandle(extensionId, options, assertFrontendActive, generation)
        },
        registerConnectionEditorTab(options) {
          assertLegacyPermission('ctx.ui.registerConnectionEditorTab')
          return createConnectionEditorTabHandle(extensionId, options, assertFrontendActive, generation)
        },
        registerPresetEditorTab(options) {
          assertPresetPermission('ctx.ui.registerPresetEditorTab')
          return createPresetEditorTabHandle(extensionId, options, assertPresetPermission, generation)
        },
        registerPresetEditorToolbarItem(options) {
          assertPresetPermission('ctx.ui.registerPresetEditorToolbarItem')
          return createPresetEditorToolbarItemHandle(extensionId, options, assertPresetPermission, generation)
        },
        createFloatWidget(options) {
          assertLegacyPermission('ctx.ui.createFloatWidget')
          return createFloatWidgetHandle(extensionId, options, assertFrontendActive, generation)
        },
        requestDockPanel(options) {
          assertLegacyPermission('ctx.ui.requestDockPanel')
          return createDockPanelHandle(extensionId, options, assertFrontendActive, generation)
        },
        requestTabLocation(tabId: string, location: TabLocation) {
          assertLegacyPermission('ctx.ui.requestTabLocation')
          createTabMobilityHandle(extensionId, generation).requestTabLocation(tabId, location)
        },
        getBuiltInTabTitle(tabId: string): string | undefined {
          assertFrontendActive()
          const tab = DRAWER_TABS.find((t) => t.id === tabId)
          return tab ? (tab.tabHeaderTitle ?? tab.tabName) : undefined
        },
        getTabLocation(tabId: string): TabLocation {
          assertFrontendActive()
          return (useStore.getState().tabLocations[tabId] ?? { kind: 'main-drawer' }) as TabLocation
        },
        getBuiltInTabRoot(tabId: string): HTMLElement | undefined {
          assertLegacyPermission('ctx.ui.getBuiltInTabRoot')
          return ensureRegistryRoot(tabId)
        },
        mountApp(options) {
          assertLegacyPermission('ctx.ui.mountApp')
          return createAppMountHandle(extensionId, options, assertFrontendActive, generation)
        },
        registerInputBarAction(options) {
          assertFrontendActive()
          return createInputBarActionHandle(extensionId, manifest.name, options, assertFrontendActive, generation)
        },
        registerCssComponent(options) {
          assertFrontendActive()
          return trackEventUnsubscribe(registerCssComponent(
            extensionId,
            generation,
            options,
            `${extensionId}:${generation}:${generateUUID()}`,
          ))
        },
        registerComponentOverride(options) {
          assertFrontendActive()
          const handle = registerSpindleComponentOverride({
            ...options,
            owner: extensionId,
            generation,
          })
          trackEventUnsubscribe(() => handle.destroy())
          return handle
        },
        registerDomDecorator(options) {
          assertFrontendActive()
          return trackEventUnsubscribe(decoratorService.registerDecorator({
            ...options,
            owner: extensionId,
            generation,
          }))
        },
        registerHostIntentHandler<T extends JsonValue = JsonValue>(name: string, handler: (detail: T) => boolean) {
          assertFrontendActive()
          return trackEventUnsubscribe(registerHostIntentHandler(
            name,
            handler as unknown as HostIntentHandler,
            assertFrontendActive,
          ))
        },
        characterEditor: {
          getState() {
            assertLegacyPermission('ctx.ui.characterEditor.getState')
            return getCharacterEditorState()
          },
          onChange(handler) {
            assertLegacyPermission('ctx.ui.characterEditor.onChange')
            return trackCharacterEditorSubscription(subscribeCharacterEditorState(handler))
          },
          setExtensions(extensions, options) {
            assertLegacyPermission('ctx.ui.characterEditor.setExtensions')
            setCharacterEditorExtensions(extensions, options?.immediate === true)
          },
          updateExtensions(mutator, options) {
            assertLegacyPermission('ctx.ui.characterEditor.updateExtensions')
            updateCharacterEditorExtensions(mutator, options?.immediate === true)
          },
          flush() {
            assertLegacyPermission('ctx.ui.characterEditor.flush')
            return flushCharacterEditorExtensions()
          },
        },
        connectionEditor: {
          getEditedProfileId() {
            assertLegacyPermission('ctx.ui.connectionEditor.getEditedProfileId')
            return getEditedConnectionProfileId()
          },
          getState() {
            assertLegacyPermission('ctx.ui.connectionEditor.getState')
            return getConnectionEditorState()
          },
          onChange(handler) {
            assertLegacyPermission('ctx.ui.connectionEditor.onChange')
            return trackConnectionEditorSubscription(subscribeConnectionEditorState(handler))
          },
          onSaved(handler) {
            assertLegacyPermission('ctx.ui.connectionEditor.onSaved')
            return trackConnectionEditorSubscription(subscribeConnectionEditorSaved(handler))
          },
        },
        presetEditor: {
          get extension() {
            assertPresetPermission('ctx.ui.presetEditor.extension')
            return scopedPresetAccess.acquire()
          },
          getState() {
            assertPresetPermission('ctx.ui.presetEditor.getState')
            return getPresetEditorState()
          },
          onChange(handler) {
            assertPresetPermission('ctx.ui.presetEditor.onChange')
            return trackPresetEditorSubscription(subscribePresetEditorState(handler))
          },
          updatePreset(mutator, options) {
            assertPresetPermission('ctx.ui.presetEditor.updatePreset')
            updatePresetEditorDraft(mutator, options?.immediate === true)
          },
          flush() {
            assertPresetPermission('ctx.ui.presetEditor.flush')
            return flushPresetEditorDraft()
          },
        },
        showContextMenu(options: {
          position: { x: number; y: number }
          items: Array<{
            key: string
            label: string
            disabled?: boolean
            danger?: boolean
            active?: boolean
            type?: 'item' | 'divider'
          }>
        }): Promise<{ selectedKey: string | null }> {
          assertFrontendActive()
          const requestId = generateUUID()

          return new Promise<{ selectedKey: string | null }>((resolve) => {
            let settled = false
            const complete = (selectedKey: string | null) => {
              if (settled) return
              settled = true
              window.removeEventListener('spindle:context-menu-resolved', handler)
              pendingContextMenuCleanups.delete(cancel)
              resolve({ selectedKey })
            }
            const handler = ((e: CustomEvent) => {
              if (e.detail.requestId !== requestId) return
              complete(e.detail.selectedKey)
            }) as EventListener
            const cancel = () => {
              complete(null)
              const pending = useStore.getState().pendingContextMenu
              if (pending?.requestId === requestId && pending.extensionId === extensionId) {
                useStore.setState({ pendingContextMenu: null })
              }
            }

            pendingContextMenuCleanups.add(cancel)
            window.addEventListener('spindle:context-menu-resolved', handler)
            assertFrontendActive()
            useStore.getState().openContextMenu({
              requestId,
              extensionId,
              position: options.position,
              items: options.items,
            })
          })
        },
        showModal(options) {
          assertFrontendActive()
          if (openModalCount >= 2) throw new Error('Maximum of 2 stacked modals per extension')
          openModalCount++

          const modalId = generateUUID()
          const root = document.createElement('div')
          stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
          root.setAttribute('data-spindle-modal', modalId)
          const unregisterRoot = registerLiveRoot(extensionId, root, null, generation)
          const dismissHandlers = new Set<() => void>()
          let dismissed = false

          // Create host elements
          const backdrop = document.createElement('div')
          Object.assign(backdrop.style, {
            position: 'fixed', inset: '0', zIndex: '10003',
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          })

          const container = document.createElement('div')
          const w = Math.min(options?.width || 420, window.innerWidth - 40)
          const mh = Math.min(options?.maxHeight || 520, window.innerHeight - 40)
          Object.assign(container.style, {
            width: `${w}px`, maxHeight: `${mh}px`,
            background: 'var(--lumiverse-bg)', borderRadius: '12px',
            border: '1px solid var(--lumiverse-border)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          })

          const header = document.createElement('div')
          Object.assign(header.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: '1px solid var(--lumiverse-border)',
          })
          const titleEl = document.createElement('h3')
          Object.assign(titleEl.style, { margin: '0', fontSize: 'calc(15px * var(--lumiverse-font-scale, 1))', fontWeight: '600', color: 'var(--lumiverse-text)' })
          titleEl.textContent = options?.title || ''
          header.appendChild(titleEl)

          if (!options?.persistent) {
            const closeBtn = document.createElement('button')
            Object.assign(closeBtn.style, {
              background: 'none', border: 'none', color: 'var(--lumiverse-text-dim)',
              cursor: 'pointer', padding: '4px', borderRadius: '4px', lineHeight: '0',
            })
            closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
            closeBtn.onclick = () => handle.dismiss()
            header.appendChild(closeBtn)
          }

          const body = document.createElement('div')
          Object.assign(body.style, { padding: '16px', overflowY: 'auto', flex: '1' })
          body.appendChild(root)

          container.appendChild(header)
          container.appendChild(body)
          backdrop.appendChild(container)

          if (!options?.persistent) {
            backdrop.addEventListener('click', (e) => {
              if (e.target === backdrop) handle.dismiss()
            })
          }

          document.body.appendChild(backdrop)

          const handle = {
            root,
            modalId,
            dismiss() {
              if (dismissed) return
              dismissed = true
              openModalCount--
              unregisterRoot()
              destroyComponentsForTarget(root)
              backdrop.remove()
              modalDisposers.delete(handle.dismiss)
              for (const h of dismissHandlers) { try { h() } catch {} }
              dismissHandlers.clear()
            },
            setTitle(title: string) {
              titleEl.textContent = title
            },
            onDismiss(handler: () => void) {
              dismissHandlers.add(handler)
              return () => { dismissHandlers.delete(handler) }
            },
          }

          modalDisposers.add(handle.dismiss)
          return handle
        },
        async showConfirm(options) {
          assertFrontendActive()
          if (openModalCount >= 2) throw new Error('Maximum of 2 stacked modals per extension')
          openModalCount++

          const requestId = generateUUID()

          return new Promise<{ confirmed: boolean }>((resolve) => {
            let settled = false
            const complete = (confirmed: boolean) => {
              if (settled) return
              settled = true
              window.removeEventListener('spindle:confirm-resolved', handler)
              pendingConfirmCleanups.delete(cancel)
              openModalCount--
              resolve({ confirmed })
            }
            const handler = ((e: CustomEvent) => {
              if (e.detail?.requestId !== requestId) return
              complete(Boolean(e.detail.confirmed))
            }) as EventListener
            const cancel = () => {
              complete(false)
              const pending = useStore.getState().pendingConfirm
              if (pending?.requestId === requestId && pending.extensionId === extensionId) {
                useStore.setState({ pendingConfirm: null })
              }
            }

            pendingConfirmCleanups.add(cancel)
            window.addEventListener('spindle:confirm-resolved', handler)
            assertFrontendActive()
            useStore.getState().openSpindleConfirm({
              requestId,
              extensionId,
              extensionName: manifest.name,
              title: options.title,
              message: options.message,
              variant: options.variant || 'info',
              confirmLabel: options.confirmLabel || 'Confirm',
              cancelLabel: options.cancelLabel || 'Cancel',
            })
          })
        },
      },
      components: createComponentsHelper(
        extensionId,
        manifest.identifier,
        getMacroCatalogForExtension,
        generation,
        { hasPermission: (permission) => cachedGrantedPermissions.includes(permission) },
      ),
      uploads: {
        async pickFile(options) {
          assertFrontendActive()
          const input = document.createElement('input')
          input.type = 'file'
          input.style.display = 'none'
          input.multiple = Boolean(options?.multiple)
          if (options?.accept?.length) {
            input.accept = options.accept.join(',')
          }

          document.body.appendChild(input)

          const selected = await new Promise<File[]>((resolve, reject) => {
            let settled = false
            const cleanup = (files: File[] = [], error?: unknown) => {
              if (settled) return
              settled = true
              input.removeEventListener('change', onChange)
              input.removeEventListener('cancel', onCancel)
              pendingFilePickerCleanups.delete(cancel)
              input.remove()
              if (error !== undefined) reject(error)
              else resolve(files)
            }
            const onChange = () => cleanup(Array.from(input.files || []))
            const onCancel = () => cleanup()
            const cancel = () => cleanup()
            pendingFilePickerCleanups.add(cancel)
            input.addEventListener('change', onChange, { once: true })
            input.addEventListener('cancel', onCancel, { once: true })
            try {
              input.click()
            } catch (error) {
              cleanup([], error)
            }
          })

          assertFrontendActive()
          const maxSizeBytes = options?.maxSizeBytes
          if (maxSizeBytes !== undefined) {
            const tooLarge = selected.find((file) => file.size > maxSizeBytes)
            if (tooLarge) {
              throw new Error(`File exceeds maxSizeBytes: ${tooLarge.name}`)
            }
          }

          return Promise.all(
            selected.map(async (file) => {
              assertFrontendActive()
              const bytes = new Uint8Array(await file.arrayBuffer())
              assertFrontendActive()
              return {
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                sizeBytes: file.size,
                bytes,
              }
            })
          )
        },
      },
      permissions: {
        async getGranted() {
          assertFrontendActive()
          const res = await spindleApi.getPermissions(extensionId)
          assertFrontendActive()
          return [...res.granted]
        },
        async request(permissions: string[], options?: PermissionRequestOptions) {
          assertFrontendActive()
          const needed = permissions.filter((permission) => !cachedGrantedPermissions.includes(permission))
          if (needed.length === 0) return [...cachedGrantedPermissions]

          const requestId = generateUUID()
          const requestPermissionVersion = permissionEventVersion

          return new Promise<string[]>((resolve, reject) => {
            let settled = false
            const complete = (approved: boolean, granted: string[]) => {
              if (settled) return
              settled = true
              window.removeEventListener('spindle:permission-resolved', handler)
              pendingPermissionCleanups.delete(cancel)
              if (
                frontendLifecycleActive === false
                || currentGeneration() === false
                || (loaded && loadedExtensions.get(extensionId) !== loaded)
              ) {
                reject(new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active'))
                return
              }
              if (approved) {
                if (permissionEventVersion !== requestPermissionVersion) {
                  resolve([...cachedGrantedPermissions])
                  return
                }
                permissionEventVersion += 1
                const previousGrantedPermissions = cachedGrantedPermissions
                cachedGrantedPermissions = [...granted]
                destroyRevokedResources(previousGrantedPermissions, cachedGrantedPermissions)
                if (cachedGrantedPermissions.includes('presets')) {
                  restorePresetEditorAccess()
                } else {
                  revokePresetEditorAccess()
                }
                resolve([...cachedGrantedPermissions])
              } else {
                reject(new Error('Permission request denied by user'))
              }
            }
            const handler = ((e: CustomEvent) => {
              if (e.detail.requestId !== requestId) return
              complete(Boolean(e.detail.approved), e.detail.granted ?? [])
            }) as EventListener
            const cancel = () => {
              complete(false, [])
              const pending = useStore.getState().pendingPermissionRequest
              if (pending?.id === requestId && pending.extensionId === extensionId) {
                useStore.setState({ pendingPermissionRequest: null })
              }
            }
            pendingPermissionCleanups.add(cancel)
            window.addEventListener('spindle:permission-resolved', handler)

            assertFrontendActive()
            useStore.getState().showPermissionRequest({
              id: requestId,
              extensionId,
              extensionName: manifest.name,
              permissions: needed,
              reason: options?.reason,
            })
          })
        },
      },
      getActiveChat() {
        assertFrontendActive()
        const state = useStore.getState()
        return {
          chatId: state.activeChatId ?? null,
          characterId: state.activeCharacterId ?? null,
        }
      },
      sendToBackend(payload: unknown): void {
        assertFrontendActive()
        // Send via WebSocket to the backend worker
        wsClient.send({
          type: 'SPINDLE_BACKEND_MSG',
          extensionId,
          payload,
        })
      },
      onBackendMessage(handler: (payload: unknown) => void): () => void {
        assertFrontendActive()
        backendHandlers.add(handler)
        return () => {
          backendHandlers.delete(handler)
        }
      },
      processes: {
        register(kind: string, handler: FrontendProcessHandler): () => void {
          assertFrontendActive()
          const normalized = kind.trim()
          if (!normalized) {
            throw new Error('process kind is required')
          }
          processHandlers.set(normalized, handler)
          return () => {
            if (processHandlers.get(normalized) === handler) {
              processHandlers.delete(normalized)
            }
          }
        },
      },
      messages: {
        registerTagInterceptor(options, handler) {
          assertFrontendActive()
          return registerTagInterceptor(extensionId, manifest.name || manifest.identifier || 'Extension', options, handler)
        },
        renderWidget(options: {
          messageId: string
          widgetId: string
          html: string
          minHeight?: number
          maxHeight?: number
        }, handler?: (payload: unknown) => void) {
          assertFrontendActive()
          return upsertMessageWidget(extensionId, options, handler, corsProxy)
        },
        removeWidget(messageId: string, widgetId: string) {
          assertFrontendActive()
          removeMessageWidget(extensionId, messageId, widgetId)
        },
        getLatestMessageId(): string | null {
          assertFrontendActive()
          // Source from the chat store, NOT the DOM. The chat list is
          // virtualized, so the bubble for the latest message may not
          // be mounted right now (user scrolled up). Extensions want a
          // real id regardless of mount state — they can pair this with
          // dom.findMessageElement / dom.inject and the injection
          // registry handles auto-replay on remount.
          const msgs = useStore.getState().messages
          return msgs.length > 0 ? msgs[msgs.length - 1].id : null
        },
        getMessageIdAtIndex(index: number): string | null {
          assertFrontendActive()
          const msgs = useStore.getState().messages
          if (msgs.length === 0) return null
          // Python-style negative indexing: -1 → last, -2 → second-to-last,
          // etc. Clamping out-of-range to null keeps the caller from
          // accidentally walking off either end of the array.
          const i = index < 0 ? msgs.length + index : index
          if (i < 0 || i >= msgs.length) return null
          return msgs[i].id
        },
        listMessageIds(): string[] {
          assertFrontendActive()
          // Chronological order matches the store's array order — the
          // chat slice sorts by index_in_chat so callers can rely on
          // oldest-first / newest-last without re-sorting.
          return useStore.getState().messages.map((m) => m.id)
        },
      },
      characters: {
        async get(characterId: string) {
          assertFrontendActive()
          const character = await charactersApi.get(characterId)
          assertFrontendActive()
          return character
        },
      },
      chats: {
        async updateMessage(chatId: string, messageId: string, input: { content?: string }) {
          assertFrontendActive()
          assertLegacyPermission('ctx.chats.updateMessage')
          const updated = await runtimeMessagesApi.update(chatId, messageId, input)
          // The canonical pre-mutation check above owns this legacy leaf.

          assertFrontendActive()
          useStore.getState().updateMessage(updated.id, updated)
          return updated
        },
      },
      settings,
      display: {
        registerResolver(resolver) {
          assertFrontendActive()
          return registerDisplayResolver(manifest.identifier, resolver)
        },
        invalidate(touchedVars: string[]) {
          assertFrontendActive()
          if (touchedVars.includes('*')) invalidateDisplayRegexCache()
          else invalidateDisplayRegexCacheForVars(new Set(touchedVars))
        },
        setExpression(expression) {
          assertFrontendActive()
          const state = useStore.getState()
          if (expression.chatId !== state.activeChatId) return
          state.setActiveExpression(expression.label, expression.imageId, expression.characterId)
          if (state.isGroupChat && expression.characterId) {
            state.setGroupExpression(expression.characterId, expression.label, expression.imageId)
          }
        },
      },
      containers: {
        registerContainer: (opts: { id: string; side: 'left' | 'right' | 'top' | 'bottom'; element: HTMLElement }) => {
          assertFrontendActive()
          return useStore.getState().registerContainer(opts)
        },
        unregisterContainer: (id: string) => {
          assertFrontendActive()
          return useStore.getState().unregisterContainer(id)
        },
      },
      manifest,
    }

    const context: FrontendExtensionContext = createFrontendExtensionContext({
      base: baseContext,
      state: stateSelectorBridge,
      domain,
      geometry: createFrontendGeometryAPI(),
      onTeardown,
    })

    const cleanup = createFrontendExtensionCleanup({
      deactivatePresetEditor: () => {
        frontendLifecycleActive = false
        loaded.deactivatePresetEditor()
      },
      clearPresetEditorSubscriptions,
      destroyPlacements: () => {
        destroyAllUIEventBindingsForExtension(extensionId)
        destroyAllComponentsForExtension(extensionId, generation)
        destroyAllPlacementsForExtension(extensionId, generation)
      },
      cleanupProcesses: () => {
        for (const process of Array.from(loaded.activeProcesses.values())) {
          try {
            loaded.activeProcesses.delete(process.processId)
            process.terminal = true
            runProcessCleanupOnce(process)
            process.messageHandlers.clear()
            process.stopHandlers.clear()
            wsClient.send({
              type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
              extensionId,
              processId: process.processId,
              event: 'frontend_unloaded',
            })
          } catch {
            // no-op
          }
        }
      },
      teardown: () => {
        if (loaded.teardownClaimed) return
        loaded.teardownClaimed = true
        let firstError: unknown
        for (const handler of [...contextTeardownHandlers]) {
          contextTeardownHandlers.delete(handler)
          try {
            handler()
          } catch (error) {
            firstError ??= error
          }
        }
        const teardown = loaded.teardown
        if (teardown) {
          try {
            teardown()
          } catch (error) {
            firstError ??= error
          }
        }
        if (firstError !== undefined) throw firstError
      },
      reportTeardownError: (error) => {
        console.error(`[Spindle] Teardown error for ${loaded.identifier}:`, error)
      },
      drainEventSubscriptions: () => {
        while (loaded.eventUnsubs.length > 0) {
          const unsubs = loaded.eventUnsubs.splice(0)
          for (const unsub of unsubs) {
            try {
              unsub()
            } catch {
              // no-op
            }
          }
        }
      },
      cleanupDomAndMounts: () => {
        try {
          loaded.context.dom.cleanup()
        } catch {
          // no-op
        }
        const stopMountSync = loaded.stopMountSync
        loaded.stopMountSync = undefined
        try {
          stopMountSync?.()
        } catch {
          // no-op
        }
        for (const node of loaded.mountRoots) {
          try {
            node.remove()
          } catch {
            // no-op
          }
        }
        loaded.mountRoots = []
      },
      cleanupRegistries: () => {
        discardPendingStartupItems(extensionId, generation)
        if (bootstrappingGenerations.get(extensionId) === generation) {
          bootstrappingGenerations.delete(extensionId)
        }
        for (const cancel of [...pendingPermissionCleanups]) {
          try {
            cancel()
          } catch {
            // no-op
          }
        }
        for (const cancel of [...pendingContextMenuCleanups]) {
          try {
            cancel()
          } catch {
            // no-op
          }
        }
        for (const cancel of [...pendingConfirmCleanups]) {
          try {
            cancel()
          } catch {
            // no-op
          }
        }
        for (const cancel of [...pendingFilePickerCleanups]) {
          try {
            cancel()
          } catch {
            // no-op
          }
        }
        clearCharacterEditorSubscriptions()
        clearConnectionEditorSubscriptions()
        clearReadyTimeout(loaded)
        for (const cancel of [...pendingMacroCatalogCancellers]) cancel()
        pendingMacroCatalogCancellers.clear()
        for (const cancel of [...pendingCorsProxyCancellers]) cancel()
        pendingCorsProxyCancellers.clear()
        loaded.macroCatalogHandlers.clear()
        loaded.backendHandlers.clear()
        loaded.processHandlers.clear()
        loaded.activeProcesses.clear()
        unregisterTagInterceptorsByExtension(extensionId)
        unregisterDisplayResolver(loaded.identifier)
        removeMessageWidgetsByExtension(extensionId)
        destroyAllUIEventBindingsForExtension(extensionId)
        destroyAllComponentsForExtension(extensionId, generation)
        clearLiveRootsForExtension(extensionId, generation)
        clearTabMobilityHandle(extensionId, generation)
        clearCssComponentsForExtension(extensionId, generation)
        clearComponentOverridesForOwner(extensionId, generation)
        unloadDomDecorators()
        forgetExtensionIdentity(extensionId)
        identityRegistered = false

        if (loadedExtensions.get(extensionId) === loaded) {
          loadedExtensions.delete(extensionId)
        }
      },
    })
    cleanupLoadedExtension = cleanup
    pendingPermissionBootstraps.delete(extensionId)

    loaded = {
      id: extensionId,
      generation,
      identifier: manifest.identifier,
      manifestSignature,
      module: mod,
      context,
      teardown: mod.teardown,
      teardownClaimed: false,
      staleTeardowns: new Set(),
      eventUnsubs,
      deactivatePresetEditor: () => {
        presetEditorActive = false
        scopedPresetAccess.dispose()
      },
      backendHandlers,
      macroCatalogHandlers,
      processHandlers,
      activeProcesses,
      mountRoots: [],
      stopMountSync: cleanupMountInfra,
      isReady: false,
      holdReady: false,
      setupComplete: false,
      readyTimeout: null,
      cleanup,
    }

    let teardownResult: unknown
    try {
      if (!currentGeneration()) {
        finalizeFrontendLoadFailure(cleanupLoadedExtension, loaded, { superseded: true })
        return
      }
      loadedExtensions.set(extensionId, loaded)
      await yieldToBrowser({ when: 'paint' })
      if (!currentGeneration()) {
        finalizeFrontendLoadFailure(cleanupLoadedExtension, loaded, { superseded: true })
        return
      }
      teardownResult = mod.setup(context)
    } catch (err) {
      finalizeFrontendLoadFailure(cleanupLoadedExtension, loaded, { superseded: false })
      throw err
    }
    observeFrontendSetupTeardown(
      teardownResult,
      loaded,
      () => isCurrentLoadedExtension(loaded),
      (error) => {
        console.error(`[Spindle] Async setup error for ${loaded.identifier}:`, error)
        void unloadFrontendExtension(loaded.id)
      },
      (error) => {
        console.error(`[Spindle] Stale async setup teardown error for ${loaded.identifier}:`, error)
      },
    )
    if (!currentGeneration()) {
      finalizeFrontendLoadFailure(cleanupLoadedExtension, loaded, {
        superseded: true,
        teardownResult,
      })
      return
    }

    loaded.setupComplete = true
    loaded.mountRoots = Array.from(mountRoots.values())
    if (typeof teardownResult === 'function') {
      loaded.teardown = teardownResult as () => void
    }


    if (useStore.getState().spindleSettings?.infoLoggingEnabled) {
      console.debug(`[Spindle] Loaded frontend: ${manifest.identifier}`)
    }
    if (!loaded.isReady) {
      if (loaded.holdReady) {
        armReadyTimeout(loaded)
      } else {
        markExtensionReady(loaded, 'legacy-auto')
      }
    }
  } catch (err) {
    if (!cleanupLoadedExtension) {
      cleanupPermissionBootstrap()
      if (identityRegistered) {
        forgetExtensionIdentity(extensionId)
        identityRegistered = false
      }
    }
    console.error(`[Spindle] Failed to load frontend for ${manifest.identifier}:`, err)
  }
}

export async function loadFrontendExtension(
  extensionId: string,
  manifest: SpindleManifest,
  force = false
): Promise<void> {
  const manifestSignature = getManifestSignature(manifest)
  const pending = loadInFlight.get(extensionId)

  if (force) {
    const recent = recentForceLoads.get(extensionId)
    const loaded = loadedExtensions.get(extensionId)
    if (
      loaded
      && isCurrentLoadedExtension(loaded)
      && loaded.manifestSignature === manifestSignature
      && recent?.manifestSignature === manifestSignature
      && Date.now() - recent.completedAt < FORCE_LOAD_DEDUPE_MS
    ) {
      return
    }
  }

  if (pending && !pending.invalidated && (!force || (pending.force && pending.manifestSignature === manifestSignature))) {
    await pending.promise
    return
  }

  const next = (pending?.promise || Promise.resolve())
    .catch(() => {
      // continue queue even after previous failure
    })
    .then(() => doLoadFrontendExtension(extensionId, manifest, force))

  loadInFlight.set(extensionId, { promise: next, force, manifestSignature, invalidated: false })
  try {
    await next
    const loaded = loadedExtensions.get(extensionId)
    if (
      force
      && loaded
      && isCurrentLoadedExtension(loaded)
      && loaded.manifestSignature === manifestSignature
    ) {
      recentForceLoads.set(extensionId, { manifestSignature, completedAt: Date.now() })
    } else if (force) {
      recentForceLoads.delete(extensionId)
    }
  } finally {
    if (loadInFlight.get(extensionId)?.promise === next) {
      loadInFlight.delete(extensionId)
    }
  }
}

export async function unloadFrontendExtension(
  extensionId: string,
  options: { invalidateGeneration?: boolean } = {},
): Promise<void> {
  if (options.invalidateGeneration !== false) {
    loadGeneration.set(extensionId, (loadGeneration.get(extensionId) || 0) + 1)
    bootstrappingGenerations.delete(extensionId)
    discardPendingStartupItems(extensionId)
    recentForceLoads.delete(extensionId)
    pendingPermissionBootstraps.get(extensionId)?.()
    const pendingLoad = loadInFlight.get(extensionId)
    if (pendingLoad) pendingLoad.invalidated = true
  }
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) return

  loaded.cleanup(true)

  if (useStore.getState().spindleSettings?.infoLoggingEnabled) {
    console.debug(`[Spindle] Unloaded frontend: ${loaded.identifier}`)
  }
}

export function routeBackendMessage(extensionId: string, payload: unknown): void {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) {
    if (isMacroCatalogResponseMessage(payload)) return
    queueStartupItem(extensionId, { kind: 'backend', payload })
    return
  }
  if (!loaded.isReady && !isMacroCatalogResponseMessage(payload)) {
    queueStartupItem(extensionId, { kind: 'backend', payload })
    return
  }

  deliverBackendMessage(loaded, payload)
}

function deliverFrontendProcessEvent(loaded: LoadedExtension, payload: FrontendProcessWirePayload): void {
  if (isCurrentLoadedExtension(loaded) === false) return
  const extensionId = loaded.id
  if (payload.action === 'spawn') {
    void (async () => {
      const handler = loaded.processHandlers.get(payload.kind)
      if (!handler) {
        wsClient.send({
          type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
          extensionId,
          processId: payload.processId,
          event: 'fail',
          error: `No frontend process handler registered for kind \"${payload.kind}\"`,
        })
        return
      }

      const process: ActiveFrontendProcess = {
        processId: payload.processId,
        kind: payload.kind,
        key: payload.key,
        payload: payload.payload,
        metadata: payload.metadata,
        readySent: false,
        terminal: false,
        messageHandlers: new Set(),
        stopHandlers: new Set(),
      }
      loaded.activeProcesses.set(payload.processId, process)

      const ctx: FrontendProcessContextLocal = {
        processId: payload.processId,
        kind: payload.kind,
        ...(payload.key ? { key: payload.key } : {}),
        payload: payload.payload,
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
        ready() {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal || process.readySent) return
          process.readySent = true
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'ready',
          })
        },
        heartbeat() {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'heartbeat',
          })
        },
        send(messagePayload: unknown) {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_MSG',
            extensionId,
            processId: payload.processId,
            payload: messagePayload,
          })
        },
        onMessage(handler) {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return () => {}
          process.messageHandlers.add(handler)
          return () => {
            process.messageHandlers.delete(handler)
          }
        },
        complete(_result?: unknown) {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return
          process.terminal = true
          loaded.activeProcesses.delete(process.processId)
          runProcessCleanupOnce(process)
          process.messageHandlers.clear()
          process.stopHandlers.clear()
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'complete',
          })
        },
        fail(error: string) {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return
          process.terminal = true
          loaded.activeProcesses.delete(process.processId)
          runProcessCleanupOnce(process)
          process.messageHandlers.clear()
          process.stopHandlers.clear()
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'fail',
            error,
          })
        },
        onStop(handler) {
          if (isCurrentLoadedExtension(loaded) === false) {
            throw new Error('SPINDLE_FRONTEND_INACTIVE: extension frontend generation is no longer active')
          }
          if (process.terminal) return () => {}
          process.stopHandlers.add(handler)
          return () => {
            process.stopHandlers.delete(handler)
          }
        },
      }

      try {
        const cleanup = await handler(ctx)
        if (typeof cleanup === 'function') {
          if (process.terminal || isCurrentLoadedExtension(loaded) === false) {
            try { void Promise.resolve(cleanup()).catch(() => {}) } catch { /* no-op */ }
          } else {
            process.cleanup = cleanup
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isCurrentLoadedExtension(loaded)) ctx.fail(message)
      }
    })()
    return
  }

  const process = loaded.activeProcesses.get(payload.processId)
  if (!process) return

  if (payload.action === 'message') {
    for (const handler of process.messageHandlers) {
      try {
        handler(payload.payload)
      } catch (err) {
        console.error(`[Spindle] Frontend process message handler error for ${loaded.identifier}:`, err)
      }
    }
    return
  }

  if (payload.action === 'stop') {
    if (payload.force === true) {
      if (process.terminal) return
      process.terminal = true
      loaded.activeProcesses.delete(process.processId)
      runProcessCleanupOnce(process)
      process.messageHandlers.clear()
      process.stopHandlers.clear()
      wsClient.send({
        type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
        extensionId,
        processId: payload.processId,
        event: 'complete',
      })
      return
    }

    if (process.stopHandlers.size === 0) {
      process.terminal = true
      loaded.activeProcesses.delete(process.processId)
      runProcessCleanupOnce(process)
      process.messageHandlers.clear()
      process.stopHandlers.clear()
      wsClient.send({
        type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
        extensionId,
        processId: payload.processId,
        event: 'complete',
      })
      return
    }

    for (const handler of process.stopHandlers) {
      try {
        handler({ reason: payload.reason })
      } catch (err) {
        console.error(`[Spindle] Frontend process stop handler error for ${loaded.identifier}:`, err)
      }
    }
  }
}

export function routeFrontendProcessEvent(extensionId: string, payload: FrontendProcessWirePayload): void {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded || !loaded.isReady) {
    queueStartupItem(extensionId, { kind: 'process', payload })
    return
  }

  deliverFrontendProcessEvent(loaded, payload)
}

export function getLoadedExtensions(): Map<string, LoadedExtension> {
  return loadedExtensions
}

export function hasExtensionMountPoint(extensionId: string, point: SpindleMountPoint): boolean {
  return extensionMountPoints.get(extensionId)?.has(point) ?? false
}

export function subscribeExtensionMountPoints(listener: () => void): () => void {
  extensionMountPointListeners.add(listener)
  return () => {
    extensionMountPointListeners.delete(listener)
  }
}

export function getExtensionMountPointsVersion(): number {
  return extensionMountPointsVersion
}

export async function unloadAllFrontendExtensions(): Promise<void> {
  for (const [id] of loadedExtensions) {
    await unloadFrontendExtension(id)
  }
}
