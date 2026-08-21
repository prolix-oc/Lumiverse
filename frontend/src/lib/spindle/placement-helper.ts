import type {
  SpindleDrawerTabOptions,
  SpindleDrawerTabHandle,
  SpindleFloatWidgetOptions,
  SpindleFloatWidgetHandle,
  SpindleDockPanelOptions,
  SpindleDockPanelHandle,
  SpindleAppMountOptions,
  SpindleAppMountHandle,
  SpindleInputBarActionOptions,
  SpindleInputBarActionHandle,
} from 'lumiverse-spindle-types'
import type {
  SpindleCharacterEditorTabOptions,
  SpindleCharacterEditorTabHandle,
} from './character-editor-types'
import type {
  SpindleConnectionEditorTabOptions,
  SpindleConnectionEditorTabHandle,
} from './connection-editor-types'
import type {
  SpindlePresetEditorTabOptions,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorToolbarItemOptions,
  SpindlePresetEditorToolbarItemHandle,
} from './preset-editor-types'
import {
  activateExtensionSettingsTab,
  getExtensionSettingsTabRegistrations,
  registerExtensionSettingsTab,
  type SpindleSettingsTabHandle,
  type SpindleSettingsTabOptions,
} from './settings-tab-bridge'
import { useStore } from '@/store'
import type { SpindleTabLocation as TabLocation } from 'lumiverse-spindle-types'
import type { SpindlePlacementSlice } from '@/types/store'
import { isTabDispatchable } from './tab-dispatch'
import {
  getCharacterEditorState,
  subscribeCharacterEditorState,
  setCharacterEditorActiveTab,
} from './character-editor-helper'
import {
  getPresetEditorState,
  subscribePresetEditorState,
  setPresetEditorActiveTab,
} from './preset-editor-helper'
import { destroyComponentsForTarget } from './components-helper'
import { getLiveRootRecordExact, registerLiveRoot, unregisterLiveRoot } from './live-root-registry'
import type { FloatWidgetState, DockPanelState, SettingsTabState } from '@/store/slices/spindle-placement'
import {
  clampLayoutRect,
  createResizeController,
  getUiScale,
  layoutViewportSize,
  type ResizeEdge,
} from './zoom-layer-geometry'
import type { PlacementGeometryBounds, SurfaceRectPrefs } from '@/types/store'
import { placementGeometryKey as makePlacementGeometryKey } from '@/store/slices/spindle-placement'
import { stampExtensionRoot } from './extension-root-stamp'

export type PlacementGuard = () => void

let placementCounter = 0
function nextId(extensionId: string, kind: string): string {
  return `spindle:${extensionId}:${kind}:${++placementCounter}`
}

function canRemovePlacementRoot(root: Element, extensionId?: string, generation?: number): boolean {
  if (extensionId === undefined) return true
  if (getLiveRootRecordExact(extensionId, root, generation)) return true
  if (generation !== undefined) return false
  return root.getAttribute('data-spindle-extension-root') === extensionId
}

function removePlacementRoot(
  root: Element,
  unregisterRoot?: () => void,
  extensionId?: string,
  generation?: number,
): void {
  if (!canRemovePlacementRoot(root, extensionId, generation)) return
  destroyComponentsForTarget(root)
  root.remove()
  unregisterRoot?.()
  if (!unregisterRoot) unregisterLiveRoot(root, extensionId, generation)
}
// Each call to createTabMobilityHandle subscribes to useStore.
// Cache one handle per extensionId to avoid subscription leaks.


export type PlacementPermission = 'characters' | 'ui_panels' | 'app_manipulation' | 'presets' | 'generation' | null

interface PlacementDisposerMetadata {
  permission: PlacementPermission
  generation?: number
  placementId?: string
}

const placementDisposers = new Map<string, Set<() => void>>()
const placementDisposerPermissions = new Map<string, Map<() => void, PlacementDisposerMetadata>>()
const placementFullCleanupInProgress = new Set<string>()
const placementPermissionCleanupInProgress = new Map<string, Set<PlacementPermission>>()
const presetEditorPlacementDisposers = new Map<string, Set<() => void>>()
const presetEditorPlacementPermissions = new Map<string, Map<() => void, PlacementDisposerMetadata>>()
const presetEditorCleanupInProgress = new Set<string>()

function runCleanupSteps(...steps: Array<() => void>): void {
  let firstError: unknown
  let hasError = false
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      if (!hasError) {
        firstError = error
        hasError = true
      }
    }
  }
  if (hasError) throw firstError
}

const PLACEMENT_DESTROYED_ERROR = new Error('PLACEMENT_DESTROYED: Placement handle has been destroyed')

function assertPlacementUsable(destroyed: boolean): void {
  if (destroyed) throw PLACEMENT_DESTROYED_ERROR
}

function assertPlacementRegistrationAllowed(
  extensionId: string,
  requiredPermission: PlacementPermission = null,
): void {
  const permissionCleanup = placementPermissionCleanupInProgress.get(extensionId)
  if (
    placementFullCleanupInProgress.has(extensionId)
    || (requiredPermission === 'presets' && presetEditorCleanupInProgress.has(extensionId))
    || permissionCleanup?.has(requiredPermission)
  ) {
    throw new Error('PLACEMENT_DESTROYED: Extension placements are being torn down')
  }
}

function trackPlacementDisposer(
  extensionId: string,
  dispose: () => void,
  requiredPermission: PlacementPermission = 'ui_panels',
  generation?: number,
  placementId?: string,
): () => void {
  assertPlacementRegistrationAllowed(extensionId, requiredPermission)
  const disposers = placementDisposers.get(extensionId) ?? new Set<() => void>()
  placementDisposers.set(extensionId, disposers)
  const permissions = placementDisposerPermissions.get(extensionId) ?? new Map<() => void, PlacementDisposerMetadata>()
  placementDisposerPermissions.set(extensionId, permissions)
  let active = true
  let disposing = false
  const tracked = () => {
    if (!active || disposing) return
    disposing = true
    try {
      dispose()
      active = false
      disposers.delete(tracked)
      permissions.delete(tracked)
      if (placementDisposers.get(extensionId) === disposers && disposers.size === 0) {
        placementDisposers.delete(extensionId)
        placementDisposerPermissions.delete(extensionId)
      }
    } finally {
      disposing = false
    }
  }
  disposers.add(tracked)
  permissions.set(tracked, { permission: requiredPermission, generation, placementId })
  return tracked
}

function trackPresetEditorPlacement(
  extensionId: string,
  dispose: () => void,
  requiredPermission: PlacementPermission = 'presets',
  generation?: number,
  placementId?: string,
): () => void {
  assertPlacementRegistrationAllowed(extensionId, requiredPermission)
  const disposers = presetEditorPlacementDisposers.get(extensionId) ?? new Set<() => void>()
  presetEditorPlacementDisposers.set(extensionId, disposers)
  const permissions = presetEditorPlacementPermissions.get(extensionId) ?? new Map<() => void, PlacementDisposerMetadata>()
  presetEditorPlacementPermissions.set(extensionId, permissions)
  let active = true
  let disposing = false
  const tracked = () => {
    if (!active || disposing) return
    disposing = true
    try {
      dispose()
      active = false
      disposers.delete(tracked)
      permissions.delete(tracked)
      if (presetEditorPlacementDisposers.get(extensionId) === disposers && disposers.size === 0) {
        presetEditorPlacementDisposers.delete(extensionId)
        presetEditorPlacementPermissions.delete(extensionId)
      }
    } finally {
      disposing = false
    }
  }
  disposers.add(tracked)
  permissions.set(tracked, { permission: requiredPermission, generation, placementId })
  return tracked
}

type TabMobilityHandle = {
  requestTabLocation(tabId: string, location: TabLocation): void
  invalidate(): void
}

const _tabMobilityCache = new Map<string, Map<number | undefined, TabMobilityHandle>>()

function getStore() {
  return useStore.getState()
}


type GeometryRect = SurfaceRectPrefs

type H6FloatWidgetOptions = SpindleFloatWidgetOptions & {
  resizable?: boolean
  bounds?: Partial<PlacementGeometryBounds>
  aspectLock?: boolean | number
  persistGeometry?: string | false
  mobileClamp?: boolean
  onGeometryCommit?: (rect: GeometryRect) => void
}

type H6DockPanelOptions = SpindleDockPanelOptions & {
  persistGeometry?: string | false
  respectRequestedEdge?: boolean
  /** Show the panel title while the dock is collapsed. Defaults to false. */
  showCollapsedTitle?: boolean
  onGeometryCommit?: (rect: GeometryRect) => void
}

export interface H6DockPanelHandle extends SpindleDockPanelHandle {
  setSize(size: number): void
  setMinSize(size: number): void
  setMaxSize(size: number): void
}

function layoutViewportBounds(): GeometryRect {
  const viewport = layoutViewportSize(undefined, safeUiScale())
  return {
    x: 0,
    y: 0,
    width: viewport.width > 0 ? viewport.width : 1440,
    height: viewport.height > 0 ? viewport.height : 900,
  }
}

interface ResolvedGeometryBounds {
  viewport: GeometryRect
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
  stateBounds: PlacementGeometryBounds
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeUiScale(): number {
  try { return getUiScale() } catch { return 1 }
}

function normalizeAspectLock(value: boolean | number | undefined): boolean | number | undefined {
  if (value === true || value === false) return value
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

const RESIZE_EDGES: ReadonlySet<ResizeEdge> = new Set([
  'top', 'right', 'bottom', 'left',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
])

function isResizeEdge(value: unknown): value is ResizeEdge {
  return typeof value === 'string' && RESIZE_EDGES.has(value as ResizeEdge)
}

function resolveGeometryBounds(bounds?: Partial<PlacementGeometryBounds>): ResolvedGeometryBounds {
  const viewport = layoutViewportBounds()
  const requestedMinWidth = Math.max(1, finiteOr(bounds?.minWidth, 1))
  const requestedMinHeight = Math.max(1, finiteOr(bounds?.minHeight, 1))
  const requestedMaxWidth = Math.max(requestedMinWidth, finiteOr(bounds?.maxWidth, viewport.width))
  const requestedMaxHeight = Math.max(requestedMinHeight, finiteOr(bounds?.maxHeight, viewport.height))
  const maxWidth = Math.min(viewport.width, requestedMaxWidth)
  const maxHeight = Math.min(viewport.height, requestedMaxHeight)
  const minWidth = Math.min(requestedMinWidth, maxWidth)
  const minHeight = Math.min(requestedMinHeight, maxHeight)
  return {
    viewport,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    stateBounds: {
      minWidth: requestedMinWidth,
      minHeight: requestedMinHeight,
      maxWidth: requestedMaxWidth,
      maxHeight: requestedMaxHeight,
    },
  }
}

function aspectRatio(rect: GeometryRect, aspectLock: boolean | number | undefined): number | undefined {
  if (typeof aspectLock === 'number') return Number.isFinite(aspectLock) && aspectLock > 0 ? aspectLock : undefined
  if (aspectLock !== true) return undefined
  return rect.height > 0 && Number.isFinite(rect.width / rect.height) ? rect.width / rect.height : undefined
}

function clampGeometryRect(
  rect: GeometryRect,
  resolved: ResolvedGeometryBounds,
  aspectLock?: boolean | number,
): GeometryRect {
  let width = Math.min(Math.max(finiteOr(rect.width, resolved.minWidth), resolved.minWidth), resolved.maxWidth)
  let height = Math.min(Math.max(finiteOr(rect.height, resolved.minHeight), resolved.minHeight), resolved.maxHeight)
  const ratio = aspectRatio({ ...rect, width, height }, aspectLock)
  if (ratio) {
    width = Math.min(width, resolved.maxHeight * ratio)
    height = width / ratio
    if (height < resolved.minHeight) {
      height = resolved.minHeight
      width = height * ratio
    }
    if (width > resolved.maxWidth) {
      width = resolved.maxWidth
      height = width / ratio
    }
    if (height > resolved.maxHeight) {
      height = resolved.maxHeight
      width = height * ratio
    }
    width = Math.min(Math.max(width, resolved.minWidth), resolved.maxWidth)
    height = Math.min(Math.max(height, resolved.minHeight), resolved.maxHeight)
  }
  return clampLayoutRect({
    x: finiteOr(rect.x, resolved.viewport.x),
    y: finiteOr(rect.y, resolved.viewport.y),
    width,
    height,
  }, resolved.viewport, { minSize: { width: resolved.minWidth, height: resolved.minHeight } })
}

function readPersistedGeometry(
  key: string | undefined,
  resolved: ResolvedGeometryBounds,
  store: SpindlePlacementSlice,
  aspectLock?: boolean | number,
): GeometryRect | undefined {
  const persisted = key ? store.persistedPlacementGeometry[key] : undefined
  return persisted ? clampGeometryRect(persisted, resolved, aspectLock) : undefined
}

function writePersistedGeometry(
  key: string | undefined,
  rect: GeometryRect,
  store: SpindlePlacementSlice,
): void {
  if (key) store.setPersistedPlacementGeometry(key, rect)
}

function clampDockSize(value: unknown, minSize: number, maxSize: number): number {
  const requested = finiteOr(value, minSize)
  return Math.max(minSize, Math.min(Math.round(requested), maxSize))
}

// ── Drawer Tab ──

export function createDrawerTabHandle(
  extensionId: string,
  options: SpindleDrawerTabOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleDrawerTabHandle {
  assertPlacementRegistrationAllowed(extensionId, null)
  assertActive()
  const tabId = nextId(extensionId, `tab:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  root.setAttribute('data-spindle-drawer-tab', tabId)
  const unregisterRoot = registerLiveRoot(extensionId, root, null, generation)

  const activateHandlers = new Set<() => void>()
  const unsubscribeStore = useStore.subscribe((state, previousState) => {
    if (state.drawerTab !== tabId || previousState.drawerTab === tabId) return
    for (const handler of activateHandlers) {
      try { handler() } catch { /* no-op */ }
    }
  })

  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      unsubscribeStore,
      () => { if (registered) getStore().unregisterDrawerTab(tabId) },
      () => activateHandlers.clear(),
    )
    cleanupComplete = true
  }, null, generation, tabId)

  try {
    assertActive()
    getStore().registerDrawerTab({
    id: tabId,
    extensionId,
    title: options.title,
    shortName: options.shortName,
    description: options.description,
    keywords: options.keywords,
    headerTitle: options.headerTitle,
    guide: options.guide
      ? {
          markdown: options.guide.markdown,
          title: options.guide.title,
        }
      : undefined,
    iconUrl: options.iconUrl,
    iconSvg: options.iconSvg,
    badge: null,
    root,
  })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterDrawerTab(tabId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    tabId,
    setTitle(title: string) {
      assertPlacementUsable(destroyed)
      getStore().updateDrawerTab(tabId, { title })
    },
    setShortName(shortName: string) {
      assertPlacementUsable(destroyed)
      getStore().updateDrawerTab(tabId, { shortName })
    },
    setBadge(text: string | null) {
      assertPlacementUsable(destroyed)
      getStore().updateDrawerTab(tabId, { badge: text })
    },
    activate() {
      assertPlacementUsable(destroyed)
      const store = getStore()
      store.setDrawerTab(tabId)
      store.openDrawer(tabId)
    },
    destroy: dispose,
    onActivate(handler: () => void): () => void {
      assertPlacementUsable(destroyed)
      activateHandlers.add(handler)
      return () => { activateHandlers.delete(handler) }
    },
  }
}

// ── Settings Tab ──

export function createSettingsTabHandle(
  extensionId: string,
  options: SpindleSettingsTabOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleSettingsTabHandle {
  assertPlacementRegistrationAllowed(extensionId, null)
  assertActive()

  const registrationId = nextId(extensionId, `settings-tab:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  root.setAttribute('data-spindle-settings-tab', options.id)
  root.setAttribute('data-spindle-settings-registration', registrationId)
  root.setAttribute('data-spindle-mount-point', 'settings_tab')
  root.setAttribute('data-settings-tab-id', options.id)
  const unregisterRoot = registerLiveRoot(extensionId, root, null, generation)

  let registration: ReturnType<typeof registerExtensionSettingsTab> | undefined
  let registered = false
  let destroyed = false
  let cleanupComplete = false
  let disposedDuringRegistration = false

  try {
    registration = registerExtensionSettingsTab({
      registrationId,
      extensionId,
      options,
    })
    const metadata = getExtensionSettingsTabRegistrations(options.id)
      .find((entry) => entry.registrationId === registrationId)
    if (!metadata) throw new Error('SETTINGS_TAB_REGISTRATION_MISSING')

    const dispose = trackPlacementDisposer(extensionId, () => {
      if (cleanupComplete) return
      destroyed = true
      if (!registered) disposedDuringRegistration = true
      runCleanupSteps(
        () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
        () => { registration?.destroy() },
        () => { if (registered) getStore().unregisterSettingsTab(registrationId) },
      )
      cleanupComplete = true
    }, null, generation, registrationId)

    try {
      assertActive()
      const state: SettingsTabState = {
        id: registrationId,
        extensionId,
        tabId: metadata.tabId,
        title: metadata.title,
        shortName: metadata.shortName,
        description: metadata.description,
        iconSvg: metadata.iconSvg,
        keywords: [...metadata.keywords],
        sections: metadata.sections.map((section) => ({ ...section, keywords: [...section.keywords] })),
        position: metadata.position,
        order: metadata.order,
        sequence: metadata.sequence,
        root,
      }
      getStore().registerSettingsTab(state)
      registered = true
      if (disposedDuringRegistration) {
        getStore().unregisterSettingsTab(registrationId)
        throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
      }
    } catch (error) {
      dispose()
      throw error
    }

    return {
      root,
      registrationId,
      tabId: metadata.tabId,
      setTitle(title: string) {
        assertPlacementUsable(destroyed)
        registration?.setTitle(title)
        getStore().updateSettingsTab(registrationId, { title })
      },
      activate() {
        assertPlacementUsable(destroyed)
        getStore().openSettings(metadata.tabId)
        activateExtensionSettingsTab(metadata.tabId)
      },
      destroy: dispose,
      onActivate(handler: () => void): () => void {
        assertPlacementUsable(destroyed)
        return registration?.onActivate(handler) ?? (() => undefined)
      },
    }
  } catch (error) {
    try { registration?.destroy() } catch { /* no-op */ }
    removePlacementRoot(root, unregisterRoot, extensionId, generation)
    throw error
  }
}

// ── Character Editor Tab ──
export function createCharacterEditorTabHandle(
  extensionId: string,
  options: SpindleCharacterEditorTabOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleCharacterEditorTabHandle {
  assertPlacementRegistrationAllowed(extensionId, 'characters')
  assertActive()
  const tabId = nextId(extensionId, `character-editor-tab:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  root.setAttribute('data-spindle-character-editor-tab', tabId)
  const unregisterRoot = registerLiveRoot(extensionId, root, 'characters', generation)

  const activateHandlers = new Set<() => void>()
  let wasActive = getCharacterEditorState().open && getCharacterEditorState().activeTabId === tabId

  const unsubscribeState = subscribeCharacterEditorState((state) => {
    const isActive = state.open && state.activeTabId === tabId
    if (isActive && !wasActive) {
      for (const handler of activateHandlers) {
        try { handler() } catch { /* no-op */ }
      }
    }
    wasActive = isActive
  })

  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      unsubscribeState,
      () => { if (registered) getStore().unregisterCharacterEditorTab(tabId) },
      () => activateHandlers.clear(),
    )
    cleanupComplete = true
  }, 'characters', generation, tabId)

  try {
    assertActive()
    getStore().registerCharacterEditorTab({
    id: tabId,
    extensionId,
    title: options.title,
    guide: options.guide
      ? {
          markdown: options.guide.markdown,
          title: options.guide.title,
        }
      : undefined,
    root,
  })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterCharacterEditorTab(tabId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    tabId,
    setTitle(title: string) {
      assertPlacementUsable(destroyed)
      getStore().updateCharacterEditorTab(tabId, { title })
    },
    activate() {
      assertPlacementUsable(destroyed)
      setCharacterEditorActiveTab(tabId)
    },
    destroy: dispose,
    onActivate(handler: () => void): () => void {
      assertPlacementUsable(destroyed)
      activateHandlers.add(handler)
      return () => { activateHandlers.delete(handler) }
    },
  }
}

// ── Preset Editor Tab ──

// Connection editor tabs are generation-scoped because their callbacks
// observe the currently edited connection surface.
export function createConnectionEditorTabHandle(
  extensionId: string,
  options: SpindleConnectionEditorTabOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleConnectionEditorTabHandle {
  assertPlacementRegistrationAllowed(extensionId, 'generation')
  assertActive()
  const tabId = nextId(extensionId, `connection-editor-tab:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  root.setAttribute('data-spindle-connection-editor-tab', tabId)
  const unregisterRoot = registerLiveRoot(extensionId, root, 'generation', generation)

  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      () => { if (registered) getStore().unregisterConnectionEditorTab(tabId) },
    )
    cleanupComplete = true
  }, 'generation', generation, tabId)

  try {
    assertActive()
    getStore().registerConnectionEditorTab({
      id: tabId,
      extensionId,
      title: options.title,
      iconSvg: options.iconSvg,
      order: options.order,
      root,
    })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterConnectionEditorTab(tabId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    tabId,
    setTitle(title: string) {
      assertPlacementUsable(destroyed)
      assertActive()
      getStore().updateConnectionEditorTab(tabId, { title })
    },
    destroy: dispose,
  }
}

export function createPresetEditorTabHandle(
  extensionId: string,
  options: SpindlePresetEditorTabOptions,
  assertActive: PlacementGuard,
  generation?: number,
): SpindlePresetEditorTabHandle {
  assertPlacementRegistrationAllowed(extensionId, 'presets')
  assertActive()
  const tabId = nextId(extensionId, `preset-editor-tab:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  const unregisterRoot = registerLiveRoot(extensionId, root, 'presets', generation)


  const activateHandlers = new Set<() => void>()
  let wasActive = getPresetEditorState().open && getPresetEditorState().activeTabId === tabId
  const unsubscribeState = subscribePresetEditorState((state) => {
    const isActive = state.open && state.activeTabId === tabId
    if (isActive && !wasActive) {
      for (const handler of activateHandlers) {
        try { handler() } catch { /* no-op */ }
      }
    }
    wasActive = isActive
  })

  let destroyed = false
  let cleanupComplete = false
  let destroying = false
  let registered = false
  let disposedDuringRegistration = false
  const destroy = trackPresetEditorPlacement(extensionId, () => {
    if (cleanupComplete || destroying) return
    destroyed = true
    destroying = true
    if (!registered) disposedDuringRegistration = true
    try {
      runCleanupSteps(
        unsubscribeState,
        () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
        () => { if (registered) getStore().unregisterPresetEditorTab(tabId) },
        () => activateHandlers.clear(),
      )
      cleanupComplete = true
    } finally {
      destroying = false
    }
  }, 'presets', generation, tabId)

  try {
    assertActive()
      getStore().registerPresetEditorTab({
    id: tabId,
    extensionId,
    title: options.title,
    guide: options.guide
      ? {
          markdown: options.guide.markdown,
          title: options.guide.title,
        }
      : undefined,
    root,
  })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterPresetEditorTab(tabId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    destroy()
    throw error
  }

  const assertUsable = () => {
    assertActive()
    if (destroyed || destroying) throw new Error('PRESET_EDITOR_DESTROYED: Preset editor tab has been destroyed')
  }

  return {
    root,
    tabId,
    setTitle(title: string) {
      assertUsable()
      getStore().updatePresetEditorTab(tabId, { title })
    },
    activate() {
      assertUsable()
      setPresetEditorActiveTab(tabId)
    },
    destroy,
    onActivate(handler: () => void): () => void {
      assertUsable()
      activateHandlers.add(handler)
      return () => { activateHandlers.delete(handler) }
    },
  }
}

// ── Preset Editor Toolbar ──

export function createPresetEditorToolbarItemHandle(
  extensionId: string,
  options: SpindlePresetEditorToolbarItemOptions,
  assertActive: PlacementGuard,
  generation?: number,
): SpindlePresetEditorToolbarItemHandle {
  assertPlacementRegistrationAllowed(extensionId, 'presets')
  assertActive()
  const itemId = nextId(extensionId, `preset-editor-toolbar:${options.id}`)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  const unregisterRoot = registerLiveRoot(extensionId, root, 'presets', generation)

  let destroyed = false
  let cleanupComplete = false
  let destroying = false
  let registered = false
  let disposedDuringRegistration = false
  const destroy = trackPresetEditorPlacement(extensionId, () => {
    if (cleanupComplete || destroying) return
    destroyed = true
    destroying = true
    if (!registered) disposedDuringRegistration = true
    try {
      runCleanupSteps(
        () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
        () => { if (registered) getStore().unregisterPresetEditorToolbarItem(itemId) },
      )
      cleanupComplete = true
    } finally {
      destroying = false
    }
  }, 'presets', generation, itemId)
  try {
    assertActive()
    getStore().registerPresetEditorToolbarItem({
      id: itemId,
      extensionId,
      ariaLabel: options.ariaLabel,
      root,
      visible: true,
    })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterPresetEditorToolbarItem(itemId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    destroy()
    throw error
  }

  const assertUsable = () => {
    assertActive()
    if (destroyed || destroying) throw new Error('PRESET_EDITOR_DESTROYED: Preset editor toolbar item has been destroyed')
  }

  return {
    root,
    itemId,
    setVisible(visible: boolean) {
      assertUsable()
      getStore().setPresetEditorToolbarItemVisible(itemId, visible)
    },
    destroy,
  }
}

// ── Float Widget ──

export function createFloatWidgetHandle(
  extensionId: string,
  options?: H6FloatWidgetOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleFloatWidgetHandle {
  assertPlacementRegistrationAllowed(extensionId, 'ui_panels')
  assertActive()
  const floatOptions = options ?? {}
  const widgetId = nextId(extensionId, 'float')
  const geometryKey = makePlacementGeometryKey(extensionId, 'float', floatOptions.persistGeometry)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  const unregisterRoot = registerLiveRoot(extensionId, root, 'ui_panels', generation)
  const geometryBounds = () => resolveGeometryBounds(floatOptions.bounds)
  const normalizedAspectLock = normalizeAspectLock(floatOptions.aspectLock)

  const defaultWidth = Math.max(1, finiteOr(floatOptions.width, 48))
  const defaultHeight = Math.max(1, finiteOr(floatOptions.height, 48))
  const viewport = layoutViewportBounds()
  const defaultBounds = geometryBounds()
  const defaultRect = clampGeometryRect({
    x: finiteOr(floatOptions.initialPosition?.x, viewport.width - defaultWidth - 16),
    y: finiteOr(floatOptions.initialPosition?.y, viewport.height - defaultHeight - 16),
    width: defaultWidth,
    height: defaultHeight,
  }, defaultBounds, normalizedAspectLock)
  const initialRect = readPersistedGeometry(geometryKey, defaultBounds, getStore(), normalizedAspectLock) ?? defaultRect

  const dragEndHandlers = new Set<(pos: { x: number; y: number }) => void>()
  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false

  const updateRect = (rect: GeometryRect) => {
    const next = clampGeometryRect(rect, geometryBounds(), normalizedAspectLock)
    getStore().updateFloatWidget(widgetId, next)
    return next
  }
  const commitRect = (rect: GeometryRect) => {
    const next = updateRect(rect)
    writePersistedGeometry(geometryKey, next, getStore())
    try { floatOptions.onGeometryCommit?.(next) } catch { /* extension callback errors do not break placement */ }
    return next
  }
  const resizeDisposers = new Map<unknown, () => void>()
  const handleResizeHandleReady = ((event: CustomEvent) => {
    if (floatOptions.resizable === false || event.detail?.widgetId !== widgetId) return
    const handle = event.detail?.handle
    if (!handle || typeof handle.addEventListener !== 'function') return
    if (typeof handle.getAttribute === 'function' && handle.getAttribute('data-spindle-float-resize-handle') !== widgetId) return
    const resolved = geometryBounds()
    const edge = isResizeEdge(event.detail?.edge) ? event.detail.edge : 'bottom-right'
    resizeDisposers.get(handle)?.()
    resizeDisposers.set(handle, createResizeController({
      element: handle,
      edge,
      getRect: () => {
        const widget = getStore().floatWidgets.find((entry) => entry.id === widgetId)
        return widget
          ? { x: widget.x, y: widget.y, width: widget.width, height: widget.height }
          : initialRect
      },
      onChange: updateRect,
      onCommit: commitRect,
      bounds: () => geometryBounds().viewport,
      minSize: { width: resolved.minWidth, height: resolved.minHeight },
      maxSize: { width: resolved.maxWidth, height: resolved.maxHeight },
      aspectLock: normalizedAspectLock,
      snap: floatOptions.snapToEdge ?? true,
      uiScale: safeUiScale,
    }))
  }) as EventListener
  window.addEventListener('spindle:float-resize-handle-ready', handleResizeHandleReady)

  // Listen for drag-end events from the SpindleFloatWidget component.
  const handleDragEndEvent = ((event: CustomEvent) => {
    if (event.detail?.widgetId !== widgetId) return
    const widget = getStore().floatWidgets.find((entry) => entry.id === widgetId)
    const rect = commitRect({
      x: event.detail.x as number,
      y: event.detail.y as number,
      width: widget?.width ?? initialRect.width,
      height: widget?.height ?? initialRect.height,
    })
    const pos = { x: rect.x, y: rect.y }
    for (const handler of dragEndHandlers) {
      try { handler(pos) } catch { /* extension callback errors do not break placement */ }
    }
  }) as EventListener
  window.addEventListener('spindle:float-drag-end', handleDragEndEvent)

  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => window.removeEventListener('spindle:float-resize-handle-ready', handleResizeHandleReady),
      () => window.removeEventListener('spindle:float-drag-end', handleDragEndEvent),
      () => {
        for (const resizeDisposer of resizeDisposers.values()) resizeDisposer()
        resizeDisposers.clear()
      },
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      () => { if (registered) getStore().unregisterFloatWidget(widgetId) },
      () => dragEndHandlers.clear(),
    )
    cleanupComplete = true
  }, 'ui_panels', generation, widgetId)

  try {
    assertActive()
    getStore().registerFloatWidget({
      id: widgetId,
      extensionId,
      root,
      x: initialRect.x,
      y: initialRect.y,
      defaultX: defaultRect.x,
      defaultY: defaultRect.y,
      defaultWidth: defaultRect.width,
      defaultHeight: defaultRect.height,
      width: initialRect.width,
      height: initialRect.height,
      visible: true,
      snapToEdge: floatOptions.snapToEdge ?? true,
      tooltip: floatOptions.tooltip,
      chromeless: floatOptions.chromeless,
      fullscreen: floatOptions.fullscreen ?? false,
      resizable: floatOptions.resizable !== false,
      bounds: defaultBounds.stateBounds,
      aspectLock: normalizedAspectLock,
      persistGeometry: floatOptions.persistGeometry,
      mobileClamp: floatOptions.mobileClamp !== false,
    } satisfies FloatWidgetState)
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterFloatWidget(widgetId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    widgetId,
    moveTo(newX: number, newY: number) {
      assertPlacementUsable(destroyed)
      const widget = getStore().floatWidgets.find((entry) => entry.id === widgetId)
      commitRect({
        x: newX,
        y: newY,
        width: widget?.width ?? initialRect.width,
        height: widget?.height ?? initialRect.height,
      })
    },
    getPosition() {
      assertPlacementUsable(destroyed)
      const widget = getStore().floatWidgets.find((entry) => entry.id === widgetId)
      return { x: widget?.x ?? initialRect.x, y: widget?.y ?? initialRect.y }
    },
    setSize(newWidth: number, newHeight: number) {
      assertPlacementUsable(destroyed)
      const widget = getStore().floatWidgets.find((entry) => entry.id === widgetId)
      if (!widget || widget.fullscreen || !Number.isFinite(newWidth) || !Number.isFinite(newHeight)) return

      const ratio = normalizedAspectLock === true
        ? widget.width / Math.max(1, widget.height)
        : normalizedAspectLock
      const next = commitRect({
        x: widget.x,
        y: widget.y,
        width: Math.round(newWidth),
        height: ratio ? Math.round(newWidth / ratio) : Math.round(newHeight),
      })
      window.dispatchEvent(new CustomEvent('spindle:float-size-request', {
        detail: { widgetId, width: next.width, height: next.height },
      }))
      if (useStore.getState().spindleSettings.infoLoggingEnabled) {
        console.info('[spindle:float-size-request]', { widgetId, width: next.width, height: next.height })
      }
    },
    setVisible(visible: boolean) {
      assertPlacementUsable(destroyed)
      getStore().updateFloatWidget(widgetId, { visible })
    },
    isVisible() {
      assertPlacementUsable(destroyed)
      return getStore().floatWidgets.find((entry) => entry.id === widgetId)?.visible ?? true
    },
    setFullscreen(fullscreen: boolean) {
      assertPlacementUsable(destroyed)
      const store = getStore()
      const widget = store.floatWidgets.find((entry) => entry.id === widgetId)
      if (!widget) return
      if (fullscreen) {
        const preFullscreen = { x: widget.x, y: widget.y, width: widget.width, height: widget.height }
        const viewportBounds = layoutViewportBounds()
        const next = updateRect(viewportBounds)
        store.updateFloatWidget(widgetId, {
          fullscreen: true,
          preFullscreen,
          ...next,
        })
      } else {
        const pre = widget.preFullscreen
        const restored = commitRect(pre ?? { x: widget.x, y: widget.y, width: widget.width, height: widget.height })
        store.updateFloatWidget(widgetId, {
          fullscreen: false,
          ...restored,
          preFullscreen: undefined,
        })
      }
    },
    isFullscreen() {
      assertPlacementUsable(destroyed)
      return getStore().floatWidgets.find((entry) => entry.id === widgetId)?.fullscreen ?? false
    },
    destroy: dispose,
    onDragEnd(handler: (pos: { x: number; y: number }) => void): () => void {
      assertPlacementUsable(destroyed)
      dragEndHandlers.add(handler)
      return () => { dragEndHandlers.delete(handler) }
    },
  } as SpindleFloatWidgetHandle
}

export function notifyFloatWidgetDragEnd(widgetId: string, pos: { x: number; y: number }) {
  window.dispatchEvent(
    new CustomEvent('spindle:float-drag-end', { detail: { widgetId, ...pos } }),
  )
}

// ── Dock Panel ──

export function createDockPanelHandle(
  extensionId: string,
  options: H6DockPanelOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): H6DockPanelHandle {
  assertPlacementRegistrationAllowed(extensionId, 'ui_panels')
  assertActive()
  const dockOptions = options
  const panelId = nextId(extensionId, `dock:${dockOptions.edge}`)
  const geometryKey = makePlacementGeometryKey(extensionId, 'dock', dockOptions.persistGeometry)
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  const unregisterRoot = registerLiveRoot(extensionId, root, 'ui_panels', generation)
  let minSize = Math.max(1, finiteOr(dockOptions.minSize, 200))
  let maxSize = Math.max(minSize, finiteOr(dockOptions.maxSize, 600))
  const dockBounds = () => resolveGeometryBounds({
    minWidth: minSize,
    minHeight: minSize,
    maxWidth: maxSize,
    maxHeight: maxSize,
  })
  const restoredRect = readPersistedGeometry(geometryKey, dockBounds(), getStore())
  let size = clampDockSize(restoredRect?.width ?? finiteOr(dockOptions.size, minSize), minSize, maxSize)
  const visibilityHandlers = new Set<(visible: boolean) => void>()
  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false

  const commitSize = (requestedSize: number, notify = true) => {
    size = clampDockSize(requestedSize, minSize, maxSize)
    getStore().updateDockPanel(panelId, { size })
    const rect = { x: 0, y: 0, width: size, height: size }
    writePersistedGeometry(geometryKey, rect, getStore())
    if (notify) {
      try { dockOptions.onGeometryCommit?.(rect) } catch { /* extension callback errors do not break placement */ }
    }
    return size
  }
  const handleResizeEndEvent = ((event: Event) => {
    const detail = (event as CustomEvent<{ panelId?: unknown; size?: unknown }>).detail
    if (detail?.panelId !== panelId) return
    if (typeof detail.size !== 'number' || !Number.isFinite(detail.size)) return
    commitSize(detail.size)
  }) as EventListener
  window.addEventListener('spindle:dock-resize-end', handleResizeEndEvent)

  const updateSizeBounds = () => {
    const nextSize = clampDockSize(size, minSize, maxSize)
    const changed = nextSize !== size
    size = nextSize
    getStore().updateDockPanel(panelId, { size, minSize, maxSize })
    if (changed) {
      const rect = { x: 0, y: 0, width: size, height: size }
      writePersistedGeometry(geometryKey, rect, getStore())
      try { dockOptions.onGeometryCommit?.(rect) } catch { /* extension callback errors do not break placement */ }
    }
  }

  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => window.removeEventListener('spindle:dock-resize-end', handleResizeEndEvent),
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      () => { if (registered) getStore().unregisterDockPanel(panelId) },
      () => visibilityHandlers.clear(),
    )
    cleanupComplete = true
  }, 'ui_panels', generation, panelId)

  try {
    assertActive()
    getStore().registerDockPanel({
      id: panelId,
      extensionId,
      root,
      edge: dockOptions.edge,
      title: dockOptions.title,
      size,
      minSize,
      maxSize,
      resizable: dockOptions.resizable ?? true,
      collapsed: dockOptions.startCollapsed ?? false,
      iconUrl: dockOptions.iconUrl,
      respectRequestedEdge: dockOptions.respectRequestedEdge === true,
      showCollapsedTitle: dockOptions.showCollapsedTitle === true,
      persistGeometry: dockOptions.persistGeometry,
    } satisfies DockPanelState)
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterDockPanel(panelId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    panelId,
    collapse() {
      assertPlacementUsable(destroyed)
      getStore().updateDockPanel(panelId, { collapsed: true })
      for (const handler of visibilityHandlers) {
        try { handler(false) } catch { /* extension callback errors do not break placement */ }
      }
    },
    expand() {
      assertPlacementUsable(destroyed)
      getStore().updateDockPanel(panelId, { collapsed: false })
      for (const handler of visibilityHandlers) {
        try { handler(true) } catch { /* extension callback errors do not break placement */ }
      }
    },
    isCollapsed() {
      assertPlacementUsable(destroyed)
      return getStore().dockPanels.find((entry) => entry.id === panelId)?.collapsed ?? false
    },
    setTitle(title: string) {
      assertPlacementUsable(destroyed)
      getStore().updateDockPanel(panelId, { title })
    },
    setSize(newSize: number) {
      assertPlacementUsable(destroyed)
      if (!Number.isFinite(newSize)) return
      commitSize(newSize)
    },
    setMinSize(newMinSize: number) {
      assertPlacementUsable(destroyed)
      if (!Number.isFinite(newMinSize)) return
      minSize = Math.max(1, Math.round(newMinSize))
      maxSize = Math.max(minSize, maxSize)
      updateSizeBounds()
    },
    setMaxSize(newMaxSize: number) {
      assertPlacementUsable(destroyed)
      if (!Number.isFinite(newMaxSize)) return
      maxSize = Math.max(minSize, Math.round(newMaxSize))
      updateSizeBounds()
    },
    destroy: dispose,
    onVisibilityChange(handler: (visible: boolean) => void): () => void {
      assertPlacementUsable(destroyed)
      visibilityHandlers.add(handler)
      return () => { visibilityHandlers.delete(handler) }
    },
  } as H6DockPanelHandle
}

// ── App Mount ──

export function createAppMountHandle(
  extensionId: string,
  options?: SpindleAppMountOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleAppMountHandle {
  assertPlacementRegistrationAllowed(extensionId, 'app_manipulation')
  assertActive()
  const mountId = nextId(extensionId, 'app')
  const root = document.createElement('div')
  stampExtensionRoot(root, extensionId, 'data-spindle-extension-root')
  root.setAttribute('data-spindle-app-mount', extensionId)
  const unregisterRoot = registerLiveRoot(extensionId, root, 'app_manipulation', generation)

  if (options?.className) {
    root.className = options.className
  }

  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => removePlacementRoot(root, unregisterRoot, extensionId, generation),
      () => { if (registered) getStore().unregisterAppMount(mountId) },
    )
    cleanupComplete = true
  }, 'app_manipulation', generation, mountId)

  try {
    assertActive()
    getStore().registerAppMount({
      id: mountId,
      extensionId,
      root,
      className: options?.className,
      position: (options?.position ?? 'end') as 'start' | 'end' | 'app-overlay',
      visible: true,
    })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterAppMount(mountId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    mountId,
    setVisible(visible: boolean) {
      assertPlacementUsable(destroyed)
      getStore().updateAppMount(mountId, { visible })
    },
    destroy: dispose,
  }
}

// ── Input Bar Action ──

export function createInputBarActionHandle(
  extensionId: string,
  extensionName: string,
  options: SpindleInputBarActionOptions,
  assertActive: PlacementGuard = () => {},
  _generation?: number,
): SpindleInputBarActionHandle {
  assertPlacementRegistrationAllowed(extensionId, null)
  assertActive()
  const actionId = nextId(extensionId, `action:${options.id}`)
  const clickHandlers = new Set<(payload?: unknown) => void>()
  const metadata = options as typeof options & {
    tooltip?: string
    iconName?: string
    placement?: string
    after?: string
    order?: number
    payloadVersion?: number
    source?: string
  }
  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => { if (registered) getStore().unregisterInputBarAction(actionId) },
      () => clickHandlers.clear(),
    )
    cleanupComplete = true
  }, null, _generation, actionId)

  try {
    assertActive()
    getStore().registerInputBarAction({
      id: actionId,
      contributionId: options.id,
      extensionId,
      extensionName,
      ownerToken: extensionId,
      generation: _generation,
      label: options.label,
      subtitle: options.subtitle,
      tooltip: metadata.tooltip,
      iconSvg: options.iconSvg,
      iconUrl: options.iconUrl,
      iconName: metadata.iconName,
      placement: metadata.placement,
      after: metadata.after,
      order: metadata.order,
      payloadVersion: metadata.payloadVersion,
      source: metadata.source,
      enabled: options.enabled !== false,
      externallyInvocable: (options as typeof options & { externallyInvocable?: boolean }).externallyInvocable !== false,
      clickHandlers,
    })
    registered = true
    if (disposedDuringRegistration) {
      getStore().unregisterInputBarAction(actionId)
      throw new Error('PLACEMENT_DESTROYED: Extension unloaded during placement registration')
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    actionId,
    setLabel(label: string) {
      assertPlacementUsable(destroyed)
      getStore().updateInputBarAction(actionId, { label })
    },
    setSubtitle(subtitle?: string) {
      assertPlacementUsable(destroyed)
      getStore().updateInputBarAction(actionId, { subtitle })
    },
    setEnabled(enabled: boolean) {
      assertPlacementUsable(destroyed)
      getStore().updateInputBarAction(actionId, { enabled })
    },
    onClick(handler: (payload?: unknown) => void): () => void {
      assertPlacementUsable(destroyed)
      clickHandlers.add(handler)
      return () => { clickHandlers.delete(handler) }
    },
    destroy: dispose,
  }
}

// ── Tab Mobility ──

/**
 * Create a tab mobility handle for an extension. Filters to (a) own
 * extension's tabs, (b) CORE_DRAWER_TAB_IDS.
 */
export function createTabMobilityHandle(extensionId: string, generation?: number): {
  requestTabLocation(tabId: string, location: TabLocation): void
} {
  let handles = _tabMobilityCache.get(extensionId)
  if (!handles) {
    handles = new Map()
    _tabMobilityCache.set(extensionId, handles)
  }
  const cached = handles.get(generation)
  if (cached) return cached

  const handle = createTabMobilityHandleUncached(extensionId)
  handles.set(generation, handle)
  return handle
}

/** Clear the cached tab mobility handle for an extension (call on unload). */
export function clearTabMobilityHandle(extensionId: string, generation?: number): void {
  const handles = _tabMobilityCache.get(extensionId)
  if (!handles) return
  if (generation === undefined) {
    for (const handle of handles.values()) handle.invalidate()
    _tabMobilityCache.delete(extensionId)
    return
  }
  handles.get(generation)?.invalidate()
  handles.delete(generation)
  if (handles.size === 0) _tabMobilityCache.delete(extensionId)
}

function createTabMobilityHandleUncached(extensionId: string): TabMobilityHandle {
  let active = true
  return {
    requestTabLocation(tabId: string, location: TabLocation): void {
      if (!active || !isTabDispatchable(tabId, extensionId, getStore().drawerTabs)) return
      getStore().moveTabTo(tabId, location)
    },
    invalidate(): void {
      active = false
    },
  }
}

// ── Cleanup ──

function drainPresetEditorDisposers(extensionId: string, generation?: number): void {
  const disposers = presetEditorPlacementDisposers.get(extensionId)
  const permissions = presetEditorPlacementPermissions.get(extensionId)
  if (!disposers) return
  for (const dispose of [...disposers]) {
    if (generation !== undefined && permissions?.get(dispose)?.generation !== generation) continue
    try { dispose() } catch { /* no-op */ }
  }
}

/** Destroy preset-only roots and subscriptions without unloading other extension UI. */
export function destroyPresetEditorPlacementsForExtension(
  extensionId: string,
  generation?: number,
): void {
  if (presetEditorCleanupInProgress.has(extensionId)) return
  presetEditorCleanupInProgress.add(extensionId)
  try {
    const store = getStore()
    for (const tab of store.presetEditorTabs.filter((entry) => entry.extensionId === extensionId)) {
      if (!canRemovePlacementRoot(tab.root, extensionId, generation)) continue
      try { removePlacementRoot(tab.root, undefined, extensionId, generation) } catch { /* no-op */ }
      store.unregisterPresetEditorTab(tab.id)
    }
    for (const item of store.presetEditorToolbarItems.filter((entry) => entry.extensionId === extensionId)) {
      if (!canRemovePlacementRoot(item.root, extensionId, generation)) continue
      try { removePlacementRoot(item.root, undefined, extensionId, generation) } catch { /* no-op */ }
      store.unregisterPresetEditorToolbarItem(item.id)
    }
    drainPresetEditorDisposers(extensionId, generation)
  } finally {
    presetEditorCleanupInProgress.delete(extensionId)
  }
}

function drainPlacementDisposers(extensionId: string, generation?: number): void {
  if (!placementFullCleanupInProgress.has(extensionId)) return
  const disposers = placementDisposers.get(extensionId)
  const permissions = placementDisposerPermissions.get(extensionId)
  if (!disposers) return
  for (const dispose of [...disposers]) {
    if (generation !== undefined && permissions?.get(dispose)?.generation !== generation) continue
    try { dispose() } catch { /* no-op */ }
  }
}

export function destroyPlacementsForExtensionPermission(
  extensionId: string,
  permission: PlacementPermission,
  generation?: number,
): void {
  if (placementFullCleanupInProgress.has(extensionId)) return
  if (permission === 'presets') {
    destroyPresetEditorPlacementsForExtension(extensionId, generation)
    return
  }

  const activePermissions = placementPermissionCleanupInProgress.get(extensionId) ?? new Set<PlacementPermission>()
  if (activePermissions.has(permission)) return
  activePermissions.add(permission)
  placementPermissionCleanupInProgress.set(extensionId, activePermissions)
  try {
    const disposers = placementDisposers.get(extensionId)
    const permissions = placementDisposerPermissions.get(extensionId)
    if (!disposers || !permissions) return
    for (const dispose of [...disposers]) {
      const metadata = permissions.get(dispose)
      if (metadata?.permission !== permission || (generation !== undefined && metadata.generation !== generation)) continue
      try { dispose() } catch { /* no-op */ }
    }
  } finally {
    activePermissions.delete(permission)
    if (activePermissions.size === 0 && placementPermissionCleanupInProgress.get(extensionId) === activePermissions) {
      placementPermissionCleanupInProgress.delete(extensionId)
    }
  }
}

function collectPlacementStateIds(
  store: SpindlePlacementSlice,
  extensionId: string,
  generation: number,
): Set<string> {
  const ids = new Set<string>()
  const addRoot = (id: string, root: Element) => {
    if (canRemovePlacementRoot(root, extensionId, generation)) ids.add(id)
  }
  for (const tab of store.drawerTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
  for (const tab of store.settingsTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
  for (const tab of store.characterEditorTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
  for (const tab of store.connectionEditorTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
  for (const tab of store.presetEditorTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
  for (const item of store.presetEditorToolbarItems.filter((entry) => entry.extensionId === extensionId)) addRoot(item.id, item.root)
  for (const widget of store.floatWidgets.filter((entry) => entry.extensionId === extensionId)) addRoot(widget.id, widget.root)
  for (const panel of store.dockPanels.filter((entry) => entry.extensionId === extensionId)) addRoot(panel.id, panel.root)
  for (const mount of store.appMounts.filter((entry) => entry.extensionId === extensionId)) addRoot(mount.id, mount.root)

  for (const metadata of placementDisposerPermissions.get(extensionId)?.values() ?? []) {
    if (metadata.generation === generation && metadata.placementId) ids.add(metadata.placementId)
  }
  for (const metadata of presetEditorPlacementPermissions.get(extensionId)?.values() ?? []) {
    if (metadata.generation === generation && metadata.placementId) ids.add(metadata.placementId)
  }
  return ids
}

function removePlacementStateIds(
  store: SpindlePlacementSlice,
  extensionId: string,
  ids: Set<string>,
): void {
  for (const tab of store.drawerTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterDrawerTab(tab.id)
  }
  for (const tab of store.settingsTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterSettingsTab(tab.id)
  }
  for (const tab of store.characterEditorTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterCharacterEditorTab(tab.id)
  }
  for (const tab of store.connectionEditorTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterConnectionEditorTab(tab.id)
  }
  for (const tab of store.presetEditorTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterPresetEditorTab(tab.id)
  }
  for (const item of store.presetEditorToolbarItems.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterPresetEditorToolbarItem(item.id)
  }
  for (const widget of store.floatWidgets.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterFloatWidget(widget.id)
  }
  for (const panel of store.dockPanels.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterDockPanel(panel.id)
  }
  for (const mount of store.appMounts.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterAppMount(mount.id)
  }
  for (const action of store.inputBarActions.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterInputBarAction(action.id)
  }
}

export function destroyAllPlacementsForExtension(extensionId: string, generation?: number) {
  if (placementFullCleanupInProgress.has(extensionId)) return
  placementFullCleanupInProgress.add(extensionId)
  try {
    const store = getStore()
    const scopedStateIds = generation === undefined
      ? null
      : collectPlacementStateIds(store, extensionId, generation)
    const roots = new Set<Element>()

    for (const tab of store.drawerTabs.filter((t) => t.extensionId === extensionId)) {
      roots.add(tab.root)
    }
    for (const tab of store.settingsTabs.filter((entry) => entry.extensionId === extensionId)) {
      roots.add(tab.root)
    }
    for (const tab of store.characterEditorTabs.filter((t) => t.extensionId === extensionId)) {
      roots.add(tab.root)
    }
    for (const tab of store.connectionEditorTabs.filter((t) => t.extensionId === extensionId)) {
      roots.add(tab.root)
    }
    for (const widget of store.floatWidgets.filter((entry) => entry.extensionId === extensionId)) {
      roots.add(widget.root)
    }
    for (const panel of store.dockPanels.filter((entry) => entry.extensionId === extensionId)) {
      roots.add(panel.root)
    }
    for (const mount of store.appMounts.filter((m) => m.extensionId === extensionId)) {
      roots.add(mount.root)
    }

    for (const root of roots) {
      try { removePlacementRoot(root, undefined, extensionId, generation) } catch { /* no-op */ }
    }
    drainPlacementDisposers(extensionId, generation)

    destroyPresetEditorPlacementsForExtension(extensionId, generation)
    if (scopedStateIds === null) store.removeAllByExtension(extensionId)
    else removePlacementStateIds(store, extensionId, scopedStateIds)
    destroyPresetEditorPlacementsForExtension(extensionId, generation)
    drainPlacementDisposers(extensionId, generation)
  } finally {
    placementFullCleanupInProgress.delete(extensionId)
  }
}
