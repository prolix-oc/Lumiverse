import type { StateCreator } from 'zustand'
import type {
  PlacementGeometryBounds,
  SpindlePlacementSlice,
  SurfaceRectPrefs,
} from '@/types/store'
import type {
  SpindleDockEdge,
  SpindleGuideDefinition,
  SpindleTabLocation as TabLocation,
} from 'lumiverse-spindle-types'

// ── Capacity limits ──

const PLACEMENT_LIMITS = {
  drawerTabs: { perExtension: 8, global: 64 },
  settingsTabs: { perExtension: 4, global: 32 },
  characterEditorTabs: { perExtension: 8, global: 64 },
  connectionEditorTabs: { perExtension: 4, global: 32 },
  presetEditorTabs: { perExtension: 8, global: 64 },
  presetEditorToolbarItems: { perExtension: 4, global: 32 },
  floatWidgets: { perExtension: 4, global: 32 },
  dockPanels: { perExtensionPerEdge: 2, globalPerEdge: 8 },
  appMounts: { perExtension: 2, global: 32 },
  inputBarActions: { perExtension: 8, global: 64 },
} as const

// ── State types ──

export interface DrawerTabState {
  id: string
  extensionId: string
  title: string

  /** Short label for below the sidebar icon (max ~8 chars). Falls back to title. */
  shortName?: string

  /** Description shown in command palette. Falls back to "Open {title} extension tab". */
  description?: string

  /** Keywords for command palette search. Extension name added automatically. */
  keywords?: string[]

  /** Title for the panel header navbar. Falls back to title. */
  headerTitle?: string

  /** Contextual documentation supplied by the owning extension. */
  guide?: SpindleGuideDefinition

  iconUrl?: string
  iconSvg?: string
  badge: string | null
  root: HTMLElement
}

export interface SettingsTabSectionState {
  key: string
  titleKey: string
  titleFallback: string
  keywords: string[]
}

/** One extension-owned body registered under a shared settings navigation id. */
export interface SettingsTabState {
  /** Unique placement/registration id. Multiple rows may share tabId. */
  id: string
  extensionId: string
  tabId: string
  title?: string
  shortName?: string
  description?: string
  iconSvg?: string
  keywords: string[]
  sections: SettingsTabSectionState[]
  position?: string
  order: number
  sequence: number
  root: HTMLElement
}

export interface CharacterEditorTabState {
  id: string
  extensionId: string
  title: string
  guide?: SpindleGuideDefinition
  root: HTMLElement
}

export interface ConnectionEditorTabState {
  id: string
  extensionId: string
  title: string
  iconSvg?: string
  order?: number
  root: HTMLElement
}

export interface PresetEditorTabState {
  id: string
  extensionId: string
  title: string
  guide?: SpindleGuideDefinition
  root: HTMLElement
}

export interface PresetEditorToolbarItemState {
  id: string
  extensionId: string
  ariaLabel: string
  root: HTMLElement
  visible: boolean
}

export interface FloatWidgetState {
  id: string
  extensionId: string
  root: HTMLElement
  x: number
  y: number
  defaultX: number
  defaultY: number
  defaultWidth: number
  defaultHeight: number
  width: number
  height: number
  visible: boolean
  snapToEdge: boolean
  tooltip?: string
  chromeless?: boolean
  /** Rendered in a dedicated desktop WebView instead of the page-level host. */
  desktopPoppedOut?: boolean
  fullscreen?: boolean
  /** Saved x/y/w/h from before entering fullscreen. */
  preFullscreen?: SurfaceRectPrefs
  /** Whether the host renderer should expose resize affordances. */
  resizable: boolean
  /** Host-managed size constraints. */
  bounds?: PlacementGeometryBounds
  /** `true` derives the current ratio; a number supplies an explicit ratio. */
  aspectLock?: boolean | number
  /** Extension-local persistence segment, or false to disable persistence. */
  persistGeometry?: string | false
  /** Retains the legacy small-screen size clamp when true. */
  mobileClamp: boolean
}

export interface DockPanelState {
  id: string
  extensionId: string
  root: HTMLElement
  edge: SpindleDockEdge
  title: string
  size: number
  minSize: number
  maxSize: number
  resizable: boolean
  collapsed: boolean
  iconUrl?: string
  /** Keep the requested edge instead of applying the user's dock preference. */
  respectRequestedEdge: boolean
  /** Extension-local persistence segment, or false to disable persistence. */
  persistGeometry?: string | false
}

export interface AppMountState {
  id: string
  extensionId: string
  root: HTMLElement
  className?: string
  position: 'start' | 'end' | 'app-overlay'
  visible: boolean
}

export interface InputBarActionState {
  /** Internal registration id. Use contributionId to identify the extension action. */
  id: string
  /** Stable extension-supplied action/contribution id. */
  contributionId?: string
  extensionId: string
  extensionName: string
  /** Loader-owned identity for host-surface routing. */
  ownerToken?: string
  /** Extension lifecycle generation that created this contribution. */
  generation?: number
  label: string
  subtitle?: string
  tooltip?: string
  iconSvg?: string
  iconUrl?: string
  iconName?: string
  /** Host-defined surface where this action is rendered. */
  placement?: string
  /** Contribution id that this action follows within its placement. */
  after?: string
  /** Stable ordering tie-breaker within a placement. */
  order?: number
  /** Optional version/source metadata for provider-generated invocation payloads. */
  payloadVersion?: number
  source?: string
  enabled: boolean
  /** Other extensions may invoke this action unless the owner opts out. */
  externallyInvocable?: boolean
  /** Invocation payloads are provider-owned and delivered unchanged to the extension. */
  clickHandlers: Set<(payload?: unknown) => void>
}

export interface ExtensionCommandState {
  extensionId: string
  extensionName: string
  commands: Array<{
    id: string
    label: string
    description: string
    keywords?: string[]
    scope?: 'global' | 'chat' | 'chat-idle' | 'landing' | 'character'
    externallyInvocable?: boolean
  }>
}

const HIDDEN_KEY = 'spindle:hiddenPlacements'
export const PLACEMENT_GEOMETRY_STORAGE_KEY = 'spindle:placementGeometry'
export const PERSISTENT_GEOMETRY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PERSISTENT_GEOMETRY_NAMESPACE_PATTERN = /^spindle:placementGeometry:[^:]+:(?:float|dock):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PERSISTED_GEOMETRY_VALUE = 10_000_000

export type PlacementGeometryKind = 'float' | 'dock'

export function placementGeometryKey(
  extensionId: string,
  kind: PlacementGeometryKind,
  placementKey?: string | false,
): string | undefined {
  if (placementKey === undefined || placementKey === false) return undefined
  if (!PERSISTENT_GEOMETRY_KEY_PATTERN.test(placementKey)) {
    throw new Error('INVALID_GEOMETRY_KEY: persistGeometry must be a nonempty 128-character placement key segment')
  }
  if (!extensionId || extensionId.length > 256) {
    throw new Error('INVALID_GEOMETRY_NAMESPACE: extension id must be a nonempty namespace')
  }
  return `${PLACEMENT_GEOMETRY_STORAGE_KEY}:${encodeURIComponent(extensionId)}:${kind}:${placementKey}`
}

export function isPersistableSurfaceRect(value: unknown): value is SurfaceRectPrefs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => {
    const member = candidate[key]
    return typeof member === 'number' && Number.isFinite(member) && member >= 0 && member <= MAX_PERSISTED_GEOMETRY_VALUE
  }) && candidate.width !== 0 && candidate.height !== 0
}

function loadPersistedPlacementGeometry(): Record<string, SurfaceRectPrefs> {
  try {
    const raw = localStorage.getItem(PLACEMENT_GEOMETRY_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const result: Record<string, SurfaceRectPrefs> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (PERSISTENT_GEOMETRY_NAMESPACE_PATTERN.test(key) && isPersistableSurfaceRect(value)) {
        result[key] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

function savePersistedPlacementGeometry(geometry: Record<string, SurfaceRectPrefs>): void {
  try {
    localStorage.setItem(PLACEMENT_GEOMETRY_STORAGE_KEY, JSON.stringify(geometry))
  } catch {
    // Storage is best effort; placement state remains authoritative in memory.
  }
}

function loadHiddenPlacements(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHiddenPlacements(ids: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids))
  } catch {
    // no-op
  }
}

export const createSpindlePlacementSlice: StateCreator<SpindlePlacementSlice> = (set, get) => ({
  drawerTabs: [],
  settingsTabs: [],
  characterEditorTabs: [],
  connectionEditorTabs: [],
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  floatWidgets: [],
  dockPanels: [],
  appMounts: [],
  inputBarActions: [],
  extensionCommands: [],
  hiddenPlacements: loadHiddenPlacements(),
  persistedPlacementGeometry: loadPersistedPlacementGeometry(),

  // ── Tab Mobility ──
  tabLocations: {},
  pendingActiveTabReset: null,

  // ── Drawer Tabs ──

  registerDrawerTab: (tab: DrawerTabState) => {
    const state = get()
    const extCount = state.drawerTabs.filter((t) => t.extensionId === tab.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.drawerTabs.perExtension) {
      throw new Error(`Drawer tab limit reached (max ${PLACEMENT_LIMITS.drawerTabs.perExtension} per extension)`)
    }
    if (state.drawerTabs.length >= PLACEMENT_LIMITS.drawerTabs.global) {
      throw new Error(`Global drawer tab limit reached (max ${PLACEMENT_LIMITS.drawerTabs.global})`)
    }
    set({ drawerTabs: [...state.drawerTabs, tab] })
  },

  unregisterDrawerTab: (tabId: string) => {
    set((state) => {
      const hasLocation = Object.prototype.hasOwnProperty.call(state.tabLocations, tabId)
      const nextTabLocations = hasLocation ? { ...state.tabLocations } : state.tabLocations
      if (hasLocation) delete nextTabLocations[tabId]

      return {
        drawerTabs: state.drawerTabs.filter((t) => t.id !== tabId),
        tabLocations: nextTabLocations,
        pendingActiveTabReset: state.pendingActiveTabReset === tabId
          ? null
          : state.pendingActiveTabReset,
      }
    })
  },

  updateDrawerTab: (tabId: string, updates: Partial<Pick<DrawerTabState, 'title' | 'shortName' | 'badge'>>) => {
    set((state) => ({
      drawerTabs: state.drawerTabs.map((t) =>
        t.id === tabId ? { ...t, ...updates } : t
      ),
    }))
  },

  // ── Settings Tabs ──

  registerSettingsTab: (tab: SettingsTabState) => {
    const state = get()
    const extCount = state.settingsTabs.filter((entry) => entry.extensionId === tab.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.settingsTabs.perExtension) {
      throw new Error(`Settings tab limit reached (max ${PLACEMENT_LIMITS.settingsTabs.perExtension} per extension)`)
    }
    if (state.settingsTabs.length >= PLACEMENT_LIMITS.settingsTabs.global) {
      throw new Error(`Global settings tab limit reached (max ${PLACEMENT_LIMITS.settingsTabs.global})`)
    }
    if (state.settingsTabs.some((entry) => entry.id === tab.id)) {
      throw new Error(`Settings tab registration already exists: ${tab.id}`)
    }
    set({ settingsTabs: [...state.settingsTabs, tab] })
  },

  unregisterSettingsTab: (registrationId: string) => {
    set((state) => ({
      settingsTabs: state.settingsTabs.filter((entry) => entry.id !== registrationId),
    }))
  },

  updateSettingsTab: (registrationId: string, updates: Partial<Pick<SettingsTabState, 'title'>>) => {
    set((state) => ({
      settingsTabs: state.settingsTabs.map((entry) =>
        entry.id === registrationId ? { ...entry, ...updates } : entry
      ),
    }))
  },

  // ── Character Editor Tabs ──

  registerCharacterEditorTab: (tab: CharacterEditorTabState) => {
    const state = get()
    const extCount = state.characterEditorTabs.filter((t) => t.extensionId === tab.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.characterEditorTabs.perExtension) {
      throw new Error(`Character editor tab limit reached (max ${PLACEMENT_LIMITS.characterEditorTabs.perExtension} per extension)`)
    }
    if (state.characterEditorTabs.length >= PLACEMENT_LIMITS.characterEditorTabs.global) {
      throw new Error(`Global character editor tab limit reached (max ${PLACEMENT_LIMITS.characterEditorTabs.global})`)
    }
    set({ characterEditorTabs: [...state.characterEditorTabs, tab] })
  },

  unregisterCharacterEditorTab: (tabId: string) => {
    set((state) => ({
      characterEditorTabs: state.characterEditorTabs.filter((t) => t.id !== tabId),
    }))
  },

  updateCharacterEditorTab: (tabId: string, updates: Partial<Pick<CharacterEditorTabState, 'title'>>) => {
    set((state) => ({
      characterEditorTabs: state.characterEditorTabs.map((t) =>
        t.id === tabId ? { ...t, ...updates } : t
      ),
    }))
  },

  // ── Connection Editor Tabs ──

  registerConnectionEditorTab: (tab: ConnectionEditorTabState) => {
    const state = get()
    const extCount = state.connectionEditorTabs.filter((t) => t.extensionId === tab.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.connectionEditorTabs.perExtension) {
      throw new Error(`Connection editor tab limit reached (max ${PLACEMENT_LIMITS.connectionEditorTabs.perExtension} per extension)`)
    }
    if (state.connectionEditorTabs.length >= PLACEMENT_LIMITS.connectionEditorTabs.global) {
      throw new Error(`Global connection editor tab limit reached (max ${PLACEMENT_LIMITS.connectionEditorTabs.global})`)
    }
    set({ connectionEditorTabs: [...state.connectionEditorTabs, tab] })
  },

  unregisterConnectionEditorTab: (tabId: string) => {
    set((state) => ({
      connectionEditorTabs: state.connectionEditorTabs.filter((tab) => tab.id !== tabId),
    }))
  },

  updateConnectionEditorTab: (tabId: string, updates: Partial<Pick<ConnectionEditorTabState, 'title'>>) => {
    set((state) => ({
      connectionEditorTabs: state.connectionEditorTabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      ),
    }))
  },

  // ── Preset Editor Tabs ──

  registerPresetEditorTab: (tab: PresetEditorTabState) => {
    const state = get()
    const extCount = state.presetEditorTabs.filter((t) => t.extensionId === tab.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.presetEditorTabs.perExtension) {
      throw new Error(`Preset editor tab limit reached (max ${PLACEMENT_LIMITS.presetEditorTabs.perExtension} per extension)`)
    }
    if (state.presetEditorTabs.length >= PLACEMENT_LIMITS.presetEditorTabs.global) {
      throw new Error(`Global preset editor tab limit reached (max ${PLACEMENT_LIMITS.presetEditorTabs.global})`)
    }
    set({ presetEditorTabs: [...state.presetEditorTabs, tab] })
  },

  unregisterPresetEditorTab: (tabId: string) => {
    set((state) => ({ presetEditorTabs: state.presetEditorTabs.filter((t) => t.id !== tabId) }))
  },

  updatePresetEditorTab: (tabId: string, updates: Partial<Pick<PresetEditorTabState, 'title'>>) => {
    set((state) => ({
      presetEditorTabs: state.presetEditorTabs.map((t) => t.id === tabId ? { ...t, ...updates } : t),
    }))
  },

  // ── Preset Editor Toolbar ──

  registerPresetEditorToolbarItem: (item: PresetEditorToolbarItemState) => {
    const state = get()
    const extCount = state.presetEditorToolbarItems.filter((entry) => entry.extensionId === item.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.presetEditorToolbarItems.perExtension) {
      throw new Error(`Preset editor toolbar item limit reached (max ${PLACEMENT_LIMITS.presetEditorToolbarItems.perExtension} per extension)`)
    }
    if (state.presetEditorToolbarItems.length >= PLACEMENT_LIMITS.presetEditorToolbarItems.global) {
      throw new Error(`Global preset editor toolbar item limit reached (max ${PLACEMENT_LIMITS.presetEditorToolbarItems.global})`)
    }
    set({ presetEditorToolbarItems: [...state.presetEditorToolbarItems, item] })
  },

  unregisterPresetEditorToolbarItem: (itemId: string) => {
    set((state) => ({
      presetEditorToolbarItems: state.presetEditorToolbarItems.filter((item) => item.id !== itemId),
    }))
  },

  setPresetEditorToolbarItemVisible: (itemId: string, visible: boolean) => {
    set((state) => ({
      presetEditorToolbarItems: state.presetEditorToolbarItems.map((item) =>
        item.id === itemId ? { ...item, visible } : item
      ),
    }))
  },

  // ── Float Widgets ──

  registerFloatWidget: (widget: FloatWidgetState) => {
    const state = get()
    const extCount = state.floatWidgets.filter((w) => w.extensionId === widget.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.floatWidgets.perExtension) {
      throw new Error(`Float widget limit reached (max ${PLACEMENT_LIMITS.floatWidgets.perExtension} per extension)`)
    }
    if (state.floatWidgets.length >= PLACEMENT_LIMITS.floatWidgets.global) {
      throw new Error(`Global float widget limit reached (max ${PLACEMENT_LIMITS.floatWidgets.global})`)
    }
    set({ floatWidgets: [...state.floatWidgets, widget] })
  },

  unregisterFloatWidget: (widgetId: string) => {
    set((state) => ({
      floatWidgets: state.floatWidgets.filter((w) => w.id !== widgetId),
    }))
  },

  updateFloatWidget: (widgetId: string, updates: Partial<Pick<FloatWidgetState, 'x' | 'y' | 'width' | 'height' | 'visible' | 'desktopPoppedOut' | 'fullscreen' | 'preFullscreen' | 'resizable' | 'bounds' | 'aspectLock' | 'persistGeometry' | 'mobileClamp'>>) => {
    set((state) => ({
      floatWidgets: state.floatWidgets.map((widget) => {
        if (widget.id !== widgetId) return widget
        const candidate = { ...widget, ...updates }
        const numeric = (value: number, fallback: number, minimum = 0) =>
          Number.isFinite(value) ? Math.max(minimum, value) : fallback
        return {
          ...candidate,
          x: numeric(candidate.x, widget.x),
          y: numeric(candidate.y, widget.y),
          width: numeric(candidate.width, widget.width, 1),
          height: numeric(candidate.height, widget.height, 1),
        }
      }),
    }))
  },

  // ── Dock Panels ──

  registerDockPanel: (panel: DockPanelState) => {
    const state = get()
    const extEdgeCount = state.dockPanels.filter(
      (p) => p.extensionId === panel.extensionId && p.edge === panel.edge
    ).length
    if (extEdgeCount >= PLACEMENT_LIMITS.dockPanels.perExtensionPerEdge) {
      throw new Error(`Dock panel limit reached (max ${PLACEMENT_LIMITS.dockPanels.perExtensionPerEdge} per edge per extension)`)
    }
    const edgeCount = state.dockPanels.filter((p) => p.edge === panel.edge).length
    if (edgeCount >= PLACEMENT_LIMITS.dockPanels.globalPerEdge) {
      throw new Error(`Global dock panel limit reached (max ${PLACEMENT_LIMITS.dockPanels.globalPerEdge} per edge)`)
    }
    set({ dockPanels: [...state.dockPanels, panel] })
  },

  unregisterDockPanel: (panelId: string) => {
    set((state) => ({
      dockPanels: state.dockPanels.filter((p) => p.id !== panelId),
    }))
  },

  updateDockPanel: (panelId: string, updates: Partial<Pick<DockPanelState, 'title' | 'collapsed' | 'size' | 'minSize' | 'maxSize' | 'respectRequestedEdge' | 'persistGeometry'>>) => {
    set((state) => ({
      dockPanels: state.dockPanels.map((panel) => {
        if (panel.id !== panelId) return panel
        const minSize = Number.isFinite(updates.minSize) ? Math.max(1, Math.round(updates.minSize!)) : panel.minSize
        const maxSize = Number.isFinite(updates.maxSize)
          ? Math.max(minSize, Math.round(updates.maxSize!))
          : Math.max(minSize, panel.maxSize)
        const requestedSize = Number.isFinite(updates.size) ? Math.round(updates.size!) : panel.size
        return {
          ...panel,
          ...updates,
          minSize,
          maxSize,
          size: Math.max(minSize, Math.min(requestedSize, maxSize)),
        }
      }),
    }))
  },

  setPersistedPlacementGeometry: (key: string, rect: SurfaceRectPrefs) => {
    if (!PERSISTENT_GEOMETRY_NAMESPACE_PATTERN.test(key) || !isPersistableSurfaceRect(rect)) return
    set((state) => {
      const persistedPlacementGeometry = { ...state.persistedPlacementGeometry, [key]: { ...rect } }
      savePersistedPlacementGeometry(persistedPlacementGeometry)
      return { persistedPlacementGeometry }
    })
  },

  clearPersistedPlacementGeometry: (key: string) => {
    set((state) => {
      if (!Object.prototype.hasOwnProperty.call(state.persistedPlacementGeometry, key)) return state
      const persistedPlacementGeometry = { ...state.persistedPlacementGeometry }
      delete persistedPlacementGeometry[key]
      savePersistedPlacementGeometry(persistedPlacementGeometry)
      return { persistedPlacementGeometry }
    })
  },

  // ── App Mounts ──

  registerAppMount: (mount: AppMountState) => {
    const state = get()
    const extCount = state.appMounts.filter((m) => m.extensionId === mount.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.appMounts.perExtension) {
      throw new Error(`App mount limit reached (max ${PLACEMENT_LIMITS.appMounts.perExtension} per extension)`)
    }
    if (state.appMounts.length >= PLACEMENT_LIMITS.appMounts.global) {
      throw new Error(`Global app mount limit reached (max ${PLACEMENT_LIMITS.appMounts.global})`)
    }
    set({ appMounts: [...state.appMounts, mount] })
  },

  unregisterAppMount: (mountId: string) => {
    set((state) => ({
      appMounts: state.appMounts.filter((m) => m.id !== mountId),
    }))
  },

  updateAppMount: (mountId: string, updates: Partial<Pick<AppMountState, 'visible'>>) => {
    set((state) => ({
      appMounts: state.appMounts.map((m) =>
        m.id === mountId ? { ...m, ...updates } : m
      ),
    }))
  },

  // ── Input Bar Actions ──

  registerInputBarAction: (action: InputBarActionState) => {
    const state = get()
    const extCount = state.inputBarActions.filter((a) => a.extensionId === action.extensionId).length
    if (extCount >= PLACEMENT_LIMITS.inputBarActions.perExtension) {
      throw new Error(`Input bar action limit reached (max ${PLACEMENT_LIMITS.inputBarActions.perExtension} per extension)`)
    }
    if (state.inputBarActions.length >= PLACEMENT_LIMITS.inputBarActions.global) {
      throw new Error(`Global input bar action limit reached (max ${PLACEMENT_LIMITS.inputBarActions.global})`)
    }
    set({ inputBarActions: [...state.inputBarActions, action] })
  },

  unregisterInputBarAction: (actionId: string) => {
    set((state) => ({
      inputBarActions: state.inputBarActions.filter((a) => a.id !== actionId),
    }))
  },

  updateInputBarAction: (actionId: string, updates: Partial<Pick<InputBarActionState, 'label' | 'subtitle' | 'enabled'>>) => {
    set((state) => ({
      inputBarActions: state.inputBarActions.map((a) =>
        a.id === actionId ? { ...a, ...updates } : a
      ),
    }))
  },

  // ── Extension Commands ──

  setExtensionCommands: (entry: ExtensionCommandState) => {
    set((state) => {
      const filtered = state.extensionCommands.filter((e) => e.extensionId !== entry.extensionId)
      if (entry.commands.length > 0) {
        filtered.push(entry)
      }
      return { extensionCommands: filtered }
    })
  },

  clearExtensionCommands: (extensionId: string) => {
    set((state) => ({
      extensionCommands: state.extensionCommands.filter((e) => e.extensionId !== extensionId),
    }))
  },

  // ── Shared ──

  removeAllByExtension: (extensionId: string) => {
    set((state) => {
      const removedDrawerTabIds = new Set(
        state.drawerTabs
          .filter((tab) => tab.extensionId === extensionId)
          .map((tab) => tab.id),
      )
      const nextTabLocations = removedDrawerTabIds.size > 0
        ? { ...state.tabLocations }
        : state.tabLocations
      for (const tabId of removedDrawerTabIds) {
        delete nextTabLocations[tabId]
      }

      return {
        drawerTabs: state.drawerTabs.filter((t) => t.extensionId !== extensionId),
        settingsTabs: state.settingsTabs.filter((entry) => entry.extensionId !== extensionId),
        characterEditorTabs: state.characterEditorTabs.filter((t) => t.extensionId !== extensionId),
        connectionEditorTabs: state.connectionEditorTabs.filter((t) => t.extensionId !== extensionId),
        presetEditorTabs: state.presetEditorTabs.filter((t) => t.extensionId !== extensionId),
        presetEditorToolbarItems: state.presetEditorToolbarItems.filter((item) => item.extensionId !== extensionId),
        floatWidgets: state.floatWidgets.filter((w) => w.extensionId !== extensionId),
        dockPanels: state.dockPanels.filter((p) => p.extensionId !== extensionId),
        appMounts: state.appMounts.filter((m) => m.extensionId !== extensionId),
        inputBarActions: state.inputBarActions.filter((a) => a.extensionId !== extensionId),
        extensionCommands: state.extensionCommands.filter((e) => e.extensionId !== extensionId),
        tabLocations: nextTabLocations,
        pendingActiveTabReset: removedDrawerTabIds.has(state.pendingActiveTabReset ?? '')
          ? null
          : state.pendingActiveTabReset,
      }
    })
  },

  togglePlacementVisibility: (placementId: string) => {
    set((state) => {
      const hidden = state.hiddenPlacements.includes(placementId)
        ? state.hiddenPlacements.filter((id) => id !== placementId)
        : [...state.hiddenPlacements, placementId]
      saveHiddenPlacements(hidden)
      return { hiddenPlacements: hidden }
    })
  },

  setPlacementHidden: (placementId: string, hidden: boolean) => {
    set((state) => {
      const isHidden = state.hiddenPlacements.includes(placementId)
      if (hidden === isHidden) return state
      const next = hidden
        ? [...state.hiddenPlacements, placementId]
        : state.hiddenPlacements.filter((id) => id !== placementId)
      saveHiddenPlacements(next)
      return { hiddenPlacements: next }
    })
  },

  showAllPlacements: () => {
    saveHiddenPlacements([])
    set({ hiddenPlacements: [] })
  },

  hideAllPlacements: () => {
    const state = get()
    const allIds = [
      ...state.drawerTabs.map((t) => t.id),
      ...state.settingsTabs.map((tab) => tab.id),
      ...state.floatWidgets.map((w) => w.id),
      ...state.dockPanels.map((p) => p.id),
      ...state.appMounts.map((m) => m.id),
    ]
    saveHiddenPlacements(allIds)
    set({ hiddenPlacements: allIds })
  },

  // ── Tab Mobility Actions ──

  moveTabTo: (tabId: string, location: TabLocation) => {
    set((state) => {
      const next = { ...state.tabLocations, [tabId]: location }

      // Signal ViewportDrawer to reset active tab when the moved tab leaves main-drawer
      let pendingActiveTabReset = state.pendingActiveTabReset
      if (location.kind !== 'main-drawer') {
        pendingActiveTabReset = tabId
      }

      return { tabLocations: next, pendingActiveTabReset }
    })
  },

  clearPendingActiveTabReset: () => set({ pendingActiveTabReset: null }),
})
