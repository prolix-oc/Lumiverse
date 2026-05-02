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
import { useStore } from '@/store'

let placementCounter = 0
function nextId(extensionId: string, kind: string): string {
  return `spindle:${extensionId}:${kind}:${++placementCounter}`
}

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
  options: SpindleDrawerTabOptions
): SpindleDrawerTabHandle {
  const tabId = nextId(extensionId, `tab:${options.id}`)
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  root.setAttribute('data-spindle-drawer-tab', tabId)

  const activateHandlers = new Set<() => void>()
  const unsubscribeStore = useStore.subscribe((state, previousState) => {
    if (state.drawerTab !== tabId || previousState.drawerTab === tabId) return
    for (const handler of activateHandlers) {
      try { handler() } catch { /* no-op */ }
    }
  })

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

  return {
    root,
    tabId,
    setTitle(title: string) {
      getStore().updateDrawerTab(tabId, { title })
    },
    setShortName(shortName: string) {
      getStore().updateDrawerTab(tabId, { shortName })
    },
    setBadge(text: string | null) {
      getStore().updateDrawerTab(tabId, { badge: text })
    },
    activate() {
      const store = getStore()
      store.setDrawerTab(tabId)
      store.openDrawer(tabId)
    },
    destroy() {
      unsubscribeStore()
      getStore().unregisterDrawerTab(tabId)
      activateHandlers.clear()
    },
    onActivate(handler: () => void): () => void {
      activateHandlers.add(handler)
      return () => { activateHandlers.delete(handler) }
    },
  }
}

// ── Float Widget ──

export function createFloatWidgetHandle(
  extensionId: string,
  options?: SpindleFloatWidgetOptions
): SpindleFloatWidgetHandle {
  const widgetId = nextId(extensionId, 'float')
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  root.setAttribute('data-spindle-float-widget', widgetId)

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

  return {
    root,
    widgetId,
    moveTo(newX: number, newY: number) {
      getStore().updateFloatWidget(widgetId, { x: newX, y: newY })
    },
    getPosition() {
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return { x: w?.x ?? x, y: w?.y ?? y }
    },
    setSize(newWidth: number, newHeight: number) {
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
      getStore().updateFloatWidget(widgetId, { visible })
    },
    isVisible() {
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return w?.visible ?? true
    },
    setFullscreen(fullscreen: boolean) {
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
      const w = getStore().floatWidgets.find((w) => w.id === widgetId)
      return w?.fullscreen ?? false
    },
    destroy() {
      window.removeEventListener('spindle:float-drag-end', handleDragEndEvent)
      getStore().unregisterFloatWidget(widgetId)
      dragEndHandlers.clear()
    },
    onDragEnd(handler: (pos: { x: number; y: number }) => void): () => void {
      dragEndHandlers.add(handler)
      return () => { dragEndHandlers.delete(handler) }
    },
  }
}

export function notifyFloatWidgetDragEnd(widgetId: string, pos: { x: number; y: number }) {
  // Called by the component after drag — propagate to extension handlers
  // This is a bridge; actual handlers are stored in the handle closures
  // We use a global event for this
  window.dispatchEvent(
    new CustomEvent('spindle:float-drag-end', { detail: { widgetId, ...pos } })
  )
}

// ── Dock Panel ──

export function createDockPanelHandle(
  extensionId: string,
  options: SpindleDockPanelOptions
): SpindleDockPanelHandle {
  const panelId = nextId(extensionId, `dock:${options.edge}`)
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  root.setAttribute('data-spindle-dock-panel', panelId)

  const visibilityHandlers = new Set<(visible: boolean) => void>()

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

  return {
    root,
    panelId,
    collapse() {
      getStore().updateDockPanel(panelId, { collapsed: true })
      for (const h of visibilityHandlers) {
        try { h(false) } catch { /* no-op */ }
      }
    },
    expand() {
      getStore().updateDockPanel(panelId, { collapsed: false })
      for (const h of visibilityHandlers) {
        try { h(true) } catch { /* no-op */ }
      }
    },
    isCollapsed() {
      const p = getStore().dockPanels.find((p) => p.id === panelId)
      return p?.collapsed ?? false
    },
    setTitle(title: string) {
      getStore().updateDockPanel(panelId, { title })
    },
    destroy() {
      getStore().unregisterDockPanel(panelId)
      visibilityHandlers.clear()
    },
    onVisibilityChange(handler: (visible: boolean) => void): () => void {
      visibilityHandlers.add(handler)
      return () => { visibilityHandlers.delete(handler) }
    },
  }
}

// ── App Mount ──

export function createAppMountHandle(
  extensionId: string,
  options?: SpindleAppMountOptions
): SpindleAppMountHandle {
  const mountId = nextId(extensionId, 'app')
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', extensionId)
  root.setAttribute('data-spindle-app-mount', extensionId)
  root.setAttribute('data-spindle-mount-id', mountId)
  if (options?.className) {
    root.className = options.className
  }

  getStore().registerAppMount({
    id: mountId,
    extensionId,
    root,
    className: options?.className,
    position: options?.position ?? 'end',
    visible: true,
  })

  return {
    root,
    mountId,
    setVisible(visible: boolean) {
      getStore().updateAppMount(mountId, { visible })
    },
    destroy() {
      getStore().unregisterAppMount(mountId)
      try { root.remove() } catch { /* no-op */ }
    },
  }
}

// ── Input Bar Action ──

export function createInputBarActionHandle(
  extensionId: string,
  extensionName: string,
  options: SpindleInputBarActionOptions
): SpindleInputBarActionHandle {
  const actionId = nextId(extensionId, `action:${options.id}`)
  const clickHandlers = new Set<() => void>()

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

  return {
    actionId,
    setLabel(label: string) {
      getStore().updateInputBarAction(actionId, { label })
    },
    setSubtitle(subtitle?: string) {
      getStore().updateInputBarAction(actionId, { subtitle })
    },
    setEnabled(enabled: boolean) {
      getStore().updateInputBarAction(actionId, { enabled })
    },
    onClick(handler: () => void): () => void {
      clickHandlers.add(handler)
      return () => { clickHandlers.delete(handler) }
    },
    destroy() {
      getStore().unregisterInputBarAction(actionId)
      clickHandlers.clear()
    },
  }
}

// ── Cleanup ──

export function destroyAllPlacementsForExtension(extensionId: string) {
  const store = getStore()

  // Clean up DOM for app mounts
  for (const m of store.appMounts.filter((m) => m.extensionId === extensionId)) {
    try { m.root.remove() } catch { /* no-op */ }
  }

  store.removeAllByExtension(extensionId)
}
