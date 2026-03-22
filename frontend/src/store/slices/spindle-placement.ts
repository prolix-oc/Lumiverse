import type { StateCreator } from 'zustand'
import type { SpindlePlacementSlice } from '@/types/store'
import type { SpindleDockEdge } from 'lumiverse-spindle-types'

// ── Capacity limits ──

export const PLACEMENT_LIMITS = {
  drawerTabs: { perExtension: 4, global: 8 },
  floatWidgets: { perExtension: 2, global: 8 },
  dockPanels: { perExtensionPerEdge: 1, globalPerEdge: 2 },
  appMounts: { perExtension: 1, global: 4 },
  inputBarActions: { perExtension: 4, global: 12 },
} as const

// ── State types ──

export interface DrawerTabState {
  id: string
  extensionId: string
  title: string
  iconUrl?: string
  iconSvg?: string
  badge: string | null
  root: HTMLElement
}

export interface FloatWidgetState {
  id: string
  extensionId: string
  root: HTMLElement
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  snapToEdge: boolean
  tooltip?: string
  chromeless?: boolean
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
}

export interface AppMountState {
  id: string
  extensionId: string
  root: HTMLElement
  className?: string
  position: 'start' | 'end'
  visible: boolean
}

export interface InputBarActionState {
  id: string
  extensionId: string
  extensionName: string
  label: string
  iconSvg?: string
  iconUrl?: string
  enabled: boolean
  clickHandlers: Set<() => void>
}

const HIDDEN_KEY = 'spindle:hiddenPlacements'

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
  floatWidgets: [],
  dockPanels: [],
  appMounts: [],
  inputBarActions: [],
  hiddenPlacements: loadHiddenPlacements(),

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
    set((state) => ({
      drawerTabs: state.drawerTabs.filter((t) => t.id !== tabId),
    }))
  },

  updateDrawerTab: (tabId: string, updates: Partial<Pick<DrawerTabState, 'title' | 'badge'>>) => {
    set((state) => ({
      drawerTabs: state.drawerTabs.map((t) =>
        t.id === tabId ? { ...t, ...updates } : t
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

  updateFloatWidget: (widgetId: string, updates: Partial<Pick<FloatWidgetState, 'x' | 'y' | 'visible'>>) => {
    set((state) => ({
      floatWidgets: state.floatWidgets.map((w) =>
        w.id === widgetId ? { ...w, ...updates } : w
      ),
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

  updateDockPanel: (panelId: string, updates: Partial<Pick<DockPanelState, 'title' | 'collapsed' | 'size'>>) => {
    set((state) => ({
      dockPanels: state.dockPanels.map((p) =>
        p.id === panelId ? { ...p, ...updates } : p
      ),
    }))
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

  updateInputBarAction: (actionId: string, updates: Partial<Pick<InputBarActionState, 'label' | 'enabled'>>) => {
    set((state) => ({
      inputBarActions: state.inputBarActions.map((a) =>
        a.id === actionId ? { ...a, ...updates } : a
      ),
    }))
  },

  // ── Shared ──

  removeAllByExtension: (extensionId: string) => {
    set((state) => ({
      drawerTabs: state.drawerTabs.filter((t) => t.extensionId !== extensionId),
      floatWidgets: state.floatWidgets.filter((w) => w.extensionId !== extensionId),
      dockPanels: state.dockPanels.filter((p) => p.extensionId !== extensionId),
      appMounts: state.appMounts.filter((m) => m.extensionId !== extensionId),
      inputBarActions: state.inputBarActions.filter((a) => a.extensionId !== extensionId),
    }))
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
      ...state.floatWidgets.map((w) => w.id),
      ...state.dockPanels.map((p) => p.id),
      ...state.appMounts.map((m) => m.id),
    ]
    saveHiddenPlacements(allIds)
    set({ hiddenPlacements: allIds })
  },
})
