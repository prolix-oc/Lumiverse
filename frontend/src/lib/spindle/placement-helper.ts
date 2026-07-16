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
  SpindlePresetEditorTabOptions,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorToolbarItemOptions,
  SpindlePresetEditorToolbarItemHandle,
} from './preset-editor-types'
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


export type PlacementPermission = 'characters' | 'ui_panels' | 'app_manipulation' | 'presets' | null

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

function clampFloatWidgetRect(x: number, y: number, width: number, height: number) {
  const pad = 12
  return {
    x: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
    y: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
  }
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
  root.setAttribute('data-spindle-extension-root', extensionId)
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
  root.setAttribute('data-spindle-extension-root', extensionId)
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
  root.setAttribute('data-spindle-extension-root', extensionId)
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
    getStore().registerPresetEditorTab({ id: tabId, extensionId, title: options.title, root })
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
  root.setAttribute('data-spindle-extension-root', extensionId)
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
  options?: SpindleFloatWidgetOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleFloatWidgetHandle {
  assertPlacementRegistrationAllowed(extensionId, 'ui_panels')
  assertActive()
  const widgetId = nextId(extensionId, 'float')
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  const unregisterRoot = registerLiveRoot(extensionId, root, 'ui_panels', generation)

  const width = options?.width ?? 48
  const height = options?.height ?? 48
  const x = options?.initialPosition?.x ?? (window.innerWidth - width - 16)
  const y = options?.initialPosition?.y ?? (window.innerHeight - height - 16)

  const dragEndHandlers = new Set<(pos: { x: number; y: number }) => void>()

  // Listen for drag-end events from the SpindleFloatWidget component
  const handleDragEndEvent = ((e: CustomEvent) => {
    if (e.detail?.widgetId !== widgetId) return
    const pos = { x: e.detail.x as number, y: e.detail.y as number }
    for (const handler of dragEndHandlers) {
      try { handler(pos) } catch {}
    }
  }) as EventListener
  window.addEventListener('spindle:float-drag-end', handleDragEndEvent)

  let destroyed = false
  let cleanupComplete = false
  let registered = false
  let disposedDuringRegistration = false
  const dispose = trackPlacementDisposer(extensionId, () => {
    if (cleanupComplete) return
    destroyed = true
    if (!registered) disposedDuringRegistration = true
    runCleanupSteps(
      () => window.removeEventListener('spindle:float-drag-end', handleDragEndEvent),
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
      x,
      y,
      defaultX: x,
      defaultY: y,
      defaultWidth: width,
      defaultHeight: height,
      width,
      height,
      visible: true,
      snapToEdge: options?.snapToEdge ?? true,
      tooltip: options?.tooltip,
      chromeless: options?.chromeless,
      fullscreen: options?.fullscreen ?? false,
    })
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
      getStore().updateFloatWidget(widgetId, { x: newX, y: newY })
    },
    getPosition() {
      assertPlacementUsable(destroyed)
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return { x: w?.x ?? x, y: w?.y ?? y }
    },
    setSize(newWidth: number, newHeight: number) {
      assertPlacementUsable(destroyed)
      const store = getStore()
      const w = store.floatWidgets.find((w) => w.id === widgetId)
      if (!w || w.fullscreen) return

      const width = Math.max(1, Math.round(newWidth))
      const height = Math.max(1, Math.round(newHeight))
      const pos = clampFloatWidgetRect(w.x, w.y, width, height)

      store.updateFloatWidget(widgetId, {
        width,
        height,
        x: pos.x,
        y: pos.y,
      })
    },
    setVisible(visible: boolean) {
      assertPlacementUsable(destroyed)
      getStore().updateFloatWidget(widgetId, { visible })
    },
    isVisible() {
      assertPlacementUsable(destroyed)
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return w?.visible ?? true
    },
    setFullscreen(fullscreen: boolean) {
      assertPlacementUsable(destroyed)
      const store = getStore()
      const w = store.floatWidgets.find((w) => w.id === widgetId)
      if (!w) return
      if (fullscreen) {
        // Save current state before entering fullscreen
        const preFullscreen = { x: w.x, y: w.y, width: w.width, height: w.height }
        store.updateFloatWidget(widgetId, {
          fullscreen: true,
          preFullscreen,
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        })
      } else {
        // Restore pre-fullscreen state
        const pre = w.preFullscreen
        store.updateFloatWidget(widgetId, {
          fullscreen: false,
          x: pre?.x ?? w.x,
          y: pre?.y ?? w.y,
          width: pre?.width ?? w.width,
          height: pre?.height ?? w.height,
          preFullscreen: undefined,
        })
      }
    },
    isFullscreen() {
      assertPlacementUsable(destroyed)
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return w?.fullscreen ?? false
    },
    destroy: dispose,
    onDragEnd(handler: (pos: { x: number; y: number }) => void): () => void {
      assertPlacementUsable(destroyed)
      dragEndHandlers.add(handler)
      return () => { dragEndHandlers.delete(handler) }
    },
  }
}

export function notifyFloatWidgetDragEnd(widgetId: string, pos: { x: number; y: number }) {
  window.dispatchEvent(
    new CustomEvent('spindle:float-drag-end', { detail: { widgetId, ...pos } }),
  )
}

// ── Dock Panel ──

export function createDockPanelHandle(
  extensionId: string,
  options: SpindleDockPanelOptions,
  assertActive: PlacementGuard = () => {},
  generation?: number,
): SpindleDockPanelHandle {
  assertPlacementRegistrationAllowed(extensionId, 'ui_panels')
  assertActive()
  const panelId = nextId(extensionId, `dock:${options.edge}`)
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  const unregisterRoot = registerLiveRoot(extensionId, root, 'ui_panels', generation)


  const visibilityHandlers = new Set<(visible: boolean) => void>()

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
      edge: options.edge,
      title: options.title,
      size: options.size,
      minSize: options.minSize ?? 200,
      maxSize: options.maxSize ?? 600,
      resizable: options.resizable ?? true,
      collapsed: options.startCollapsed ?? false,
      iconUrl: options.iconUrl,
    })
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
      for (const h of visibilityHandlers) {
        try { h(false) } catch { /* no-op */ }
      }
    },
    expand() {
      assertPlacementUsable(destroyed)
      getStore().updateDockPanel(panelId, { collapsed: false })
      for (const h of visibilityHandlers) {
        try { h(true) } catch { /* no-op */ }
      }
    },
    isCollapsed() {
      assertPlacementUsable(destroyed)
      const p = getStore().dockPanels.find((p) => p.id === panelId)
      return p?.collapsed ?? false
    },
    setTitle(title: string) {
      assertPlacementUsable(destroyed)
      getStore().updateDockPanel(panelId, { title })
    },
    destroy: dispose,
    onVisibilityChange(handler: (visible: boolean) => void): () => void {
      assertPlacementUsable(destroyed)
      visibilityHandlers.add(handler)
      return () => { visibilityHandlers.delete(handler) }
    },
  }
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
  root.setAttribute('data-spindle-extension-root', extensionId)
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
  const clickHandlers = new Set<() => void>()
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
      extensionId,
      extensionName,
      label: options.label,
      subtitle: options.subtitle,
      iconSvg: options.iconSvg,
      iconUrl: options.iconUrl,
      enabled: options.enabled !== false,
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
    onClick(handler: () => void): () => void {
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
  for (const tab of store.characterEditorTabs.filter((entry) => entry.extensionId === extensionId)) addRoot(tab.id, tab.root)
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
  for (const tab of store.characterEditorTabs.filter((entry) => entry.extensionId === extensionId && ids.has(entry.id))) {
    store.unregisterCharacterEditorTab(tab.id)
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
    for (const tab of store.characterEditorTabs.filter((t) => t.extensionId === extensionId)) {
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
