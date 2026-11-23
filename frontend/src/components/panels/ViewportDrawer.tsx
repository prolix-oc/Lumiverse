import { useRef, useState, useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Check, ChevronRight, CircleHelp, LayoutGrid, List, Settings, Sparkles } from 'lucide-react'
import {
  MouseSensor,
  pointerWithin, rectIntersection,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragMoveEvent, type DragOverEvent, type Modifier,
} from '@dnd-kit/core'
import { DndContext } from '@/lib/dndUiScale'
import { applyDrawerSidebarDrop, canMergeDrawerSidebarTabs, constrainDrawerSidebarDrag, drawerSidebarDividerDropId, drawerSidebarDropSide, type DrawerSidebarDropSide } from '@/lib/drawer-sidebar-drop'
import { DrawerMobilePointerDrag, type DrawerMobileDragCallbacks } from '@/lib/drawer-mobile-pointer'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { CloseButton } from '@/components/shared/CloseButton'
import { openGuide } from '@/lib/guides/reader-session'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import {
  DRAWER_TABS,
  adaptExtensionTabs,
  sanitizeHiddenDrawerTabIds,
  preloadDrawerTab,
  type DrawerTabEntry,
} from '@/lib/drawer-tab-registry'
import {
  canonicalDrawerLayoutTabId,
  DRAWER_LAYOUT_ROOT_END_ID,
  DRAWER_LAYOUT_ROOT_START_ID,
  drawerLayoutItemKey,
  drawerLayoutTabKey,
  flattenDrawerLayoutTabIds,
  reconcileDrawerLayout,
  updateDrawerLayoutFolderView,
} from '@/lib/drawer-layout'
import { DrawerFolderIcon } from '@/lib/drawer-folder-icons'
import { translateDrawerField } from '@/lib/i18n/resolveLabel'
import { useTranslation } from 'react-i18next'
import TabPanelContent from './TabPanelContent'
import styles from './ViewportDrawer.module.css'
import clsx from 'clsx'
import { filterEnabledFrontendContributions } from '@/lib/spindle/frontend-extension-availability'
import { useDrawerTabDrag } from '@/hooks/useDrawerTabDrag'
import { useDrawerResize } from '@/hooks/useDrawerResize'
import { getUiScale } from '@/lib/uiScale'
import { duoPaneStyle, type DuoLayout } from '@/lib/ios-duo-layout'
import { useDrawerTabPreload } from '@/hooks/useDrawerTabPreload'
import { scheduleIdleDrawerPreload } from '@/lib/drawer-tab-preload'

const FOLDER_HOVER_MS = 700

type SidebarHover = { id: string; side: DrawerSidebarDropSide; ready: boolean; merging: boolean } | null

function isHorizontalSidebar(): boolean {
  return window.matchMedia?.('(max-width: 600px)').matches ?? window.innerWidth <= 600
}

// Desktop dnd-kit remains enabled, but its visual movement is restricted to
// the rail's actual axis. Otherwise a dragged icon can create horizontal
// overflow, and dnd-kit auto-scroll shifts the entire vertical icon column.
const lockSidebarDragToRail: Modifier = ({ transform }) =>
  constrainDrawerSidebarDrag(transform, isHorizontalSidebar())

function getDragSide(event: DragMoveEvent | DragOverEvent | DragEndEvent): DrawerSidebarDropSide {
  return drawerSidebarDropSide(
    event.active.rect.current.translated ?? event.active.rect.current.initial,
    event.over?.rect,
    isHorizontalSidebar(),
  )
}

/** Keep the real button and its Spindle mount within one stable drag item. */
function SidebarDragItem({
  id, enabled, child = false, hover, suppressClick, children, mobileDrag,
}: {
  id: string
  enabled: boolean
  child?: boolean
  hover: SidebarHover
  suppressClick: (event: React.MouseEvent<HTMLDivElement>, id: string) => void
  children: ReactNode
  mobileDrag?: { controller: DrawerMobilePointerDrag; railRef: React.RefObject<HTMLDivElement | null>; callbacks: DrawerMobileDragCallbacks; activeId: string | null }
}) {
  const draggable = useDraggable({ id, disabled: !enabled })
  const droppable = useDroppable({ id, disabled: !enabled })
  const { setNodeRef: setDraggableRef } = draggable
  const { setNodeRef: setDroppableRef } = droppable
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    setDraggableRef(node)
    setDroppableRef(node)
  }, [setDraggableRef, setDroppableRef])
  const canDrag = enabled || Boolean(mobileDrag)
  const transform = draggable.transform
  const scale = transform ? getUiScale() : 1
  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x / scale}px, ${transform.y / scale}px, 0)` : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        styles.tabDragSlot,
        child && styles.folderChildSlot,
        canDrag && styles.tabDragEnabled,
        (draggable.isDragging || mobileDrag?.activeId === id) && styles.tabDragActive,
        canDrag && hover?.id === id && hover.side === 'inside' && !id.startsWith('folder:') && styles.folderDropArming,
        canDrag && hover?.id === id && hover.merging && styles.folderMergeArming,
        canDrag && hover?.id === id && hover.ready && styles.folderDropReady,
        canDrag && hover?.id === id && hover.side === 'before' && styles.rootDropBefore,
        canDrag && hover?.id === id && hover.side === 'after' && styles.rootDropAfter,
      )}
      data-drawer-drag-id={id}
      data-drawer-drop-ready={hover?.id === id && hover.ready || undefined}
      onClickCapture={(event) => suppressClick(event, id)}
      {...(enabled ? draggable.listeners : {})}
      onPointerDown={mobileDrag ? (event) => mobileDrag.controller.start(event, id, mobileDrag.railRef.current, mobileDrag.callbacks) : undefined}
      onPointerMove={mobileDrag ? (event) => mobileDrag.controller.move(event) : undefined}
      onPointerUp={mobileDrag ? (event) => mobileDrag.controller.end(event) : undefined}
      onPointerCancel={mobileDrag ? (event) => mobileDrag.controller.cancel(event.pointerId) : undefined}
      onLostPointerCapture={mobileDrag ? (event) => mobileDrag.controller.cancel(event.pointerId) : undefined}
    >
      {children}
    </div>
  )
}

/** A divider is a real root insertion boundary, with no draggable chrome.
 * The two halves make before/after unambiguous on mouse and touch alike. */
function SidebarDividerDrop({ id, label, enabled, hover }: { id: string; label?: string; enabled: boolean; hover: SidebarHover }) {
  const beforeId = drawerSidebarDividerDropId(id, 'before')
  const afterId = drawerSidebarDividerDropId(id, 'after')
  const before = useDroppable({ id: beforeId, disabled: !enabled })
  const after = useDroppable({ id: afterId, disabled: !enabled })
  const beforeActive = enabled && (hover?.id === beforeId || before.isOver)
  const afterActive = enabled && (hover?.id === afterId || after.isOver)
  return (
    <div
      className={clsx(styles.tabDivider, (beforeActive || afterActive) && styles.tabDividerTarget,
        beforeActive && styles.tabDividerTargetBefore, afterActive && styles.tabDividerTargetAfter)}
      data-drawer-divider=""
      title={label || undefined}
      aria-hidden="true"
    >
      <div ref={before.setNodeRef} data-drawer-divider-drop={beforeId} className={styles.tabDividerDropHalf} />
      <div ref={after.setNodeRef} data-drawer-divider-drop={afterId} className={styles.tabDividerDropHalf} />
    </div>
  )
}

function SidebarEdgeDrop({ id, enabled, end = false }: { id: string; enabled: boolean; end?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !enabled })
  return <div ref={setNodeRef} data-drawer-edge-drop={id} className={clsx(styles.sidebarEdgeDrop, enabled && styles.sidebarEdgeDropEnabled, end && styles.sidebarEdgeDropEnd, isOver && styles.sidebarEdgeDropOver)} aria-hidden="true" />
}

export default function ViewportDrawer({ duoLayout = null }: { duoLayout?: DuoLayout | null }) {
  const { t } = useTranslation('panels')
  const { t: ts } = useTranslation('settings')
  const drawerOpen = useStore((s) => s.drawerOpen)
  const pinned = duoLayout !== null
  const drawerTab = useStore((s) => s.drawerTab)
  const openDrawer = useStore((s) => s.openDrawer)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const openSettings = useStore((s) => s.openSettings)
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const extensions = useStore((s) => s.extensions)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const isGroupChat = useStore((s) => s.isGroupChat)

  const isMobile = useIsMobile()
  const sidebarRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const resize = useDrawerResize(drawerRef, drawerSettings.side, (width) => {
    const state = useStore.getState()
    state.setSetting('drawerSettings', { ...state.drawerSettings, panelWidthPx: width }, 'user-interaction')
  })
  const tabListRef = useRef<HTMLDivElement>(null)
  const panelContentRef = useRef<HTMLDivElement>(null)
  const [tabListScroll, setTabListScroll] = useState({ up: false, down: false })
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  // Expanded sidebar folders are independent from the panel being viewed.
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set())
  const [organizeMode, setOrganizeMode] = useState(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [hover, setHover] = useState<SidebarHover>(null)
  const hoverTargetRef = useRef<string | null>(null)
  const readyTargetRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressedClickRef = useRef<string | null>(null)
  const suppressedClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextFolderRef = useRef<string | null>(null)
  const mobilePointerDrag = useMemo(() => new DrawerMobilePointerDrag(), [])
  const preloadOnIntent = useDrawerTabPreload()

  // Publish actual drawer geometry so chat reflow also follows live resizing and UI zoom.
  useEffect(() => {
    const drawer = drawerRef.current
    const app = document.querySelector<HTMLElement>('[data-app-root]')
    if (!drawer || !app) return
    const sync = () => {
      const width = drawerOpen && !isMobile && !pinned ? drawer.getBoundingClientRect().width / getUiScale() : 0
      app.style.setProperty('--chat-drawer-left', drawerSettings.side === 'left' ? `${width}px` : '0px')
      app.style.setProperty('--chat-drawer-right', drawerSettings.side === 'right' ? `${width}px` : '0px')
    }
    const observer = new ResizeObserver(sync)
    observer.observe(drawer)
    observer.observe(app)
    sync()
    return () => {
      observer.disconnect()
      app.style.removeProperty('--chat-drawer-left')
      app.style.removeProperty('--chat-drawer-right')
    }
  }, [drawerOpen, drawerSettings.side, isMobile, settingsLoaded, pinned])

  const updateTabListScroll = useCallback(() => {
    const el = tabListRef.current
    if (!el) return
    setTabListScroll({
      up: el.scrollTop > 0,
      down: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    })
  }, [])

  useEffect(() => {
    const el = tabListRef.current
    if (!el) return
    el.addEventListener('scroll', updateTabListScroll, { passive: true })
    const ro = new ResizeObserver(updateTabListScroll)
    ro.observe(el)
    updateTabListScroll()
    return () => {
      el.removeEventListener('scroll', updateTabListScroll)
      ro.disconnect()
    }
  }, [updateTabListScroll])

  const showTabLabels = drawerSettings.showTabLabels ?? true
  const hiddenTabIds = sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)
  const hiddenTabIdsSet = useMemo(
    () => new Set(hiddenTabIds.map(canonicalDrawerLayoutTabId)),
    [hiddenTabIds],
  )
  const hiddenPlacementIdsSet = useMemo(() => new Set(hiddenPlacements), [hiddenPlacements])

  const updateDrawer = useCallback(
    (partial: Partial<typeof drawerSettings>) => {
      setSetting('drawerSettings', { ...drawerSettings, ...partial })
    },
    [drawerSettings, setSetting],
  )

  const commitDrawerTabPosition = useCallback((verticalPosition: number) => {
    const state = useStore.getState()
    state.setSetting(
      'drawerSettings',
      { ...state.drawerSettings, verticalPosition },
      'user-interaction',
    )
  }, [])

  const drawerTabDrag = useDrawerTabDrag({
    position: drawerSettings.verticalPosition,
    onCommit: commitDrawerTabPosition,
  })

  const enabledDrawerTabs = filterEnabledFrontendContributions(drawerTabs, extensions)
  const extensionEntries = useMemo(() => adaptExtensionTabs(enabledDrawerTabs), [enabledDrawerTabs])
  const extensionStateById = useMemo(
    () => new Map(enabledDrawerTabs.map((tab) => [canonicalDrawerLayoutTabId(tab.id), tab] as const)),
    [enabledDrawerTabs],
  )
  const tabEntryById = useMemo(() => {
    const entries = new Map<string, DrawerTabEntry>(DRAWER_TABS.map((tab) => [tab.id, tab]))
    for (const tab of extensionEntries) entries.set(canonicalDrawerLayoutTabId(tab.id), tab)
    return entries
  }, [extensionEntries])
  const extensionIds = useMemo(
    () => new Set(extensionEntries.map((tab) => canonicalDrawerLayoutTabId(tab.id))),
    [extensionEntries],
  )

  const layout = useMemo(() => reconcileDrawerLayout({
    layout: drawerSettings.layout,
    builtInIds: DRAWER_TABS.map((tab) => tab.id),
    extensionIds: extensionEntries.map((tab) => tab.id),
    legacyTabOrder: drawerSettings.tabOrder,
  }), [drawerSettings.layout, drawerSettings.tabOrder, extensionEntries])

  const desktopDrag = useSensor(MouseSensor, { activationConstraint: { distance: 7 } })
  // Desktop retains dnd-kit; mobile Arrange Mode uses pointer capture instead
  // of the fragile delayed TouchSensor, so a moving finger always lifts the tab.
  const dragEnabled = !isMobile
  const mobileArrange = isMobile && organizeMode
  const sensors = useSensors(...(dragEnabled ? [desktopDrag] : []))

  const persistLayout = useCallback((next: typeof layout) => {
    const current = useStore.getState().drawerSettings
    useStore.getState().setSetting('drawerSettings', {
      ...current,
      layout: next,
      tabOrder: flattenDrawerLayoutTabIds(next),
    }, 'user-interaction')
  }, [])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverTargetRef.current = null
  }, [])

  const resetDrag = useCallback(() => {
    clearHoverTimer()
    readyTargetRef.current = null
    setHover(null)
    setActiveDragId(null)
  }, [clearHoverTimer])

  useEffect(() => () => {
    clearHoverTimer()
    if (suppressedClickTimerRef.current !== null) clearTimeout(suppressedClickTimerRef.current)
  }, [clearHoverTimer])

  useEffect(() => {
    if (!drawerOpen && !pinned) setOrganizeMode(false)
  }, [drawerOpen, pinned])

  const suppressDraggedClick = useCallback((event: React.MouseEvent<HTMLDivElement>, id: string) => {
    if (suppressedClickRef.current !== id) return
    suppressedClickRef.current = null
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onDragStart = useCallback((event: { active: { id: string | number } }) => {
    resetDrag()
    setActiveDragId(String(event.active.id))
  }, [resetDrag])

  const updateHoverTarget = useCallback((id: string | null, activeId: string, side: DrawerSidebarDropSide) => {
    const mergeCandidate = id && side === 'inside' && canMergeDrawerSidebarTabs(layout, activeId, id)
    if (mergeCandidate) {
      if (hoverTargetRef.current !== id) {
        clearHoverTimer()
        readyTargetRef.current = null
        hoverTargetRef.current = id
        const target = id
        hoverTimerRef.current = setTimeout(() => {
          readyTargetRef.current = target
          setHover({ id: target, side: 'inside', ready: true, merging: true })
        }, FOLDER_HOVER_MS)
      }
      setHover((prev) => prev?.id === id && prev.side === 'inside' ? prev : { id, side, ready: false, merging: true })
    } else {
      if (hoverTargetRef.current !== null) clearHoverTimer()
      readyTargetRef.current = null
      setHover((prev) => prev?.id === id && prev.side === side && !prev.ready && !prev.merging
        ? prev : id ? { id, side, ready: false, merging: false } : null)
    }
  }, [clearHoverTimer, layout])

  const updateDragHover = useCallback((event: DragMoveEvent | DragOverEvent) => {
    updateHoverTarget(event.over ? String(event.over.id) : null, String(event.active.id), getDragSide(event))
  }, [updateHoverTarget])

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    const folderReady = readyTargetRef.current === overId
    // Pointer-up is followed by a synthetic click. Never navigate as the tab moves.
    suppressedClickRef.current = activeId
    if (suppressedClickTimerRef.current !== null) clearTimeout(suppressedClickTimerRef.current)
    suppressedClickTimerRef.current = setTimeout(() => { suppressedClickRef.current = null }, 200)
    resetDrag()
    if (!overId || overId === activeId) return

    const side = getDragSide(event)
    const next = applyDrawerSidebarDrop(layout, activeId, overId, side, folderReady)
    if (JSON.stringify(next) !== JSON.stringify(layout)) persistLayout(next)
  }, [layout, persistLayout, resetDrag])

  const mobileDragCallbacks: DrawerMobileDragCallbacks = {
    onStart: (id) => {
      resetDrag()
      setActiveDragId(id)
    },
    onHover: (id, over, side) => updateHoverTarget(over, id, side),
    onDrop: (id, over, side) => {
      const ready = readyTargetRef.current === over
      suppressedClickRef.current = id
      if (suppressedClickTimerRef.current !== null) clearTimeout(suppressedClickTimerRef.current)
      suppressedClickTimerRef.current = setTimeout(() => { suppressedClickRef.current = null }, 200)
      resetDrag()
      if (!over || over === id) return
      const next = applyDrawerSidebarDrop(layout, id, over, side, ready)
      if (JSON.stringify(next) !== JSON.stringify(layout)) persistLayout(next)
    },
    onCancel: resetDrag,
  }
  const mobileDrag = mobileArrange ? { controller: mobilePointerDrag, railRef: tabListRef, callbacks: mobileDragCallbacks, activeId: activeDragId } : undefined
  useEffect(() => {
    if (!mobileArrange) mobilePointerDrag.cancel()
    return () => mobilePointerDrag.cancel()
  }, [mobileArrange, mobilePointerDrag])

  const isTabVisible = useCallback((layoutTabId: string) => {
    const entry = tabEntryById.get(layoutTabId)
    if (!entry) return false
    if (hiddenTabIdsSet.has(layoutTabId)) return false
    if (extensionIds.has(layoutTabId) && hiddenPlacementIdsSet.has(entry.id)) return false
    return true
  }, [extensionIds, hiddenPlacementIdsSet, hiddenTabIdsSet, tabEntryById])

  const allTabs = useMemo(
    () => [...tabEntryById.entries()]
      .filter(([layoutTabId]) => isTabVisible(layoutTabId))
      .map(([, tab]) => tab),
    [isTabVisible, tabEntryById],
  )
  const requestedActiveTab = drawerTab || 'profile'
  const requestedLayoutTabId = canonicalDrawerLayoutTabId(requestedActiveTab)
  const requestedEntry = isTabVisible(requestedLayoutTabId) ? tabEntryById.get(requestedLayoutTabId) : undefined
  const activeTabConfig = requestedEntry ?? tabEntryById.get('profile') ?? DRAWER_TABS[0]
  const activeTab = activeTabConfig.id
  const activeLayoutTabId = canonicalDrawerLayoutTabId(activeTab)
  const activeFolder = activeFolderId
    ? layout.find((item) => item.type === 'folder' && item.id === activeFolderId)
    : undefined
  const activeFolderTabs = activeFolder?.type === 'folder'
    ? activeFolder.children
        .filter(isTabVisible)
        .map((layoutTabId) => {
          const entry = tabEntryById.get(layoutTabId)
          return entry ? { layoutTabId, entry } : null
        })
        .filter((value): value is { layoutTabId: string; entry: DrawerTabEntry } => Boolean(value))
    : []
  const activeFolderView = activeFolder?.type === 'folder' ? activeFolder.view ?? 'list' : 'list'

  // Warm one neighboring top-level tab after opening, rather than importing
  // every panel at startup. Folder contents wait for their own interaction.
  const nearbyTabId = useMemo(() => {
    if (!settingsLoaded || (!drawerOpen && !pinned) || activeFolder) return null
    const ids = layout.flatMap(item => item.type === 'tab' && isTabVisible(item.tabId)
      && !extensionIds.has(item.tabId) ? [tabEntryById.get(item.tabId)!.id] : [])
    const index = ids.indexOf(activeTab)
    return index >= 0 ? ids[index + 1] ?? ids[index - 1] ?? null : null
  }, [settingsLoaded, drawerOpen, pinned, activeFolder, layout, isTabVisible, extensionIds, tabEntryById, activeTab])
  useEffect(() => {
    if (!nearbyTabId) return
    return scheduleIdleDrawerPreload(() => preloadDrawerTab(nearbyTabId))
  }, [nearbyTabId])

  const activeTabTitle =
    activeTab === 'profile' && isGroupChat
      ? t('group')
      : translateDrawerField(
          activeTabConfig.id,
          'tabHeaderTitle',
          activeTabConfig.tabHeaderTitle ?? activeTabConfig.tabName,
        )
  const panelTitle = activeFolder?.type === 'folder'
    ? activeFolder.name.trim() || t('viewportDrawer.folder', { defaultValue: 'Folder' })
    : activeTabTitle

  useEffect(() => {
    // A direct host/command navigation to a tab should leave folder browsing.
    setActiveFolderId(null)
  }, [drawerTab])

  useEffect(() => {
    if (drawerTab && drawerTab !== activeTab) {
      setDrawerTab(activeTab)
    }
  }, [drawerTab, activeTab, setDrawerTab])

  const pendingActiveTabReset = useStore((s) => s.pendingActiveTabReset)
  const clearPendingReset = useStore((s) => s.clearPendingActiveTabReset)
  useEffect(() => {
    if (!pendingActiveTabReset) return
    const fallback = allTabs.find((tab) => tab.id !== pendingActiveTabReset)
    setDrawerTab(fallback?.id ?? 'profile')
    clearPendingReset()
  }, [pendingActiveTabReset, allTabs, setDrawerTab, clearPendingReset])

  const handleTabClick = useCallback(
    (layoutTabId: string) => {
      const runtimeTabId = tabEntryById.get(layoutTabId)?.id ?? layoutTabId
      preloadDrawerTab(runtimeTabId)
      setActiveFolderId(null)
      setDrawerTab(runtimeTabId)
      openDrawer(runtimeTabId)
    },
    [openDrawer, setDrawerTab, tabEntryById],
  )

  const handleFolderClick = useCallback((folderId: string) => {
    const wasExpanded = expandedFolderIds.has(folderId)
    setExpandedFolderIds((previous) => {
      const next = new Set(previous)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
    // Clicking an already-expanded folder closes only that folder, even after
    // the user navigated to a tab or opened a different folder.
    setActiveFolderId((previous) => wasExpanded
      ? previous === folderId ? null : previous
      : folderId)
    openDrawer()
  }, [expandedFolderIds, openDrawer])

  const setFolderView = useCallback((view: 'list' | 'grid') => {
    if (activeFolder?.type !== 'folder') return
    const nextLayout = updateDrawerLayoutFolderView(layout, drawerLayoutItemKey(activeFolder), view)
    updateDrawer({
      layout: nextLayout,
      tabOrder: flattenDrawerLayoutTabIds(nextLayout),
    })
  }, [activeFolder, layout, updateDrawer])

  const tabQuickMenu = useLongPress({
    onLongPress: (pos) => setContextMenu(pos),
  })

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, folderId: string | null = null) => {
      // iOS/Android can dispatch their own contextmenu after a touch hold.
      // Arrange Mode owns that gesture; never reopen the quick menu mid-drag.
      if (organizeMode) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.defaultPrevented) return
      contextFolderRef.current = folderId
      tabQuickMenu.onContextMenu(e)
    },
    [organizeMode, tabQuickMenu],
  )

  const handleTabTouchStart = useCallback((e: React.TouchEvent, folderId: string | null = null) => {
    if (organizeMode) return
    contextFolderRef.current = folderId
    tabQuickMenu.onTouchStart(e)
  }, [organizeMode, tabQuickMenu])

  const contextMenuItems: ContextMenuEntry[] = [
    ...(isMobile ? [{
      key: 'organize-tabs',
      label: organizeMode
        ? t('viewportDrawer.arrangeDone', { defaultValue: 'Done arranging icons' })
        : t('viewportDrawer.arrangeIcons', { defaultValue: 'Arrange sidebar icons' }),
      onClick: () => { setOrganizeMode((value) => !value); setContextMenu(null) },
    }] : []),
    ...(contextFolderRef.current ? [{
      key: 'edit-folder',
      label: t('viewportDrawer.editFolder', { defaultValue: 'Customize Folder' }),
      onClick: () => {
        setContextMenu(null)
        openModal('configureTabs', { focusFolderId: contextFolderRef.current })
      },
    }] : []),
    {
      key: 'toggle-labels',
      label: showTabLabels ? t('viewportDrawer.hideTabLabels') : t('viewportDrawer.showTabLabels'),
      danger: showTabLabels,
      onClick: () => {
        updateDrawer({ showTabLabels: !showTabLabels })
        setContextMenu(null)
      },
    },
    {
      key: 'configure-tabs',
      label: t('viewportDrawer.configureTabs'),
      onClick: () => {
        setContextMenu(null)
        openModal('configureTabs')
      },
    },
  ]

  const isRight = drawerSettings.side === 'right'
  const isCompact = drawerSettings.tabSize === 'compact'

  const panelWidthCSS = (() => {
    if (isMobile) return 'min(420px, calc(100vw / var(--lumiverse-ui-scale, 1) - 64px))'
    const width = resize.draftWidth ?? drawerSettings.panelWidthPx
    if (typeof width === 'number' && Number.isFinite(width)) {
      return `clamp(min(280px, calc(100vw / var(--lumiverse-ui-scale, 1) - 64px)), ${width}px, min(calc(80vw / var(--lumiverse-ui-scale, 1)), calc(100vw / var(--lumiverse-ui-scale, 1) - 64px)))`
    }
    switch (drawerSettings.panelWidthMode) {
      case 'custom': return `calc(${Math.max(20, Math.min(80, drawerSettings.customPanelWidth))}vw / var(--lumiverse-ui-scale, 1))`
      default: return 'min(420px, calc(100vw / var(--lumiverse-ui-scale, 1) - 64px))'
    }
  })()

  const renderTabButton = (layoutTabId: string) => {
    const entry = tabEntryById.get(layoutTabId)
    if (!entry || !isTabVisible(layoutTabId)) return null
    const Icon = entry.tabIcon
    const extensionState = extensionStateById.get(layoutTabId)
    const title = translateDrawerField(entry.id, 'tabName', entry.tabName)
    const shortName = translateDrawerField(entry.id, 'shortName', entry.shortName)

    return (
      <button
        key={`tab:${layoutTabId}`}
        type="button"
        className={clsx(
          styles.tabBtn,
          extensionIds.has(layoutTabId) && styles.tabBtnExtension,
          showTabLabels && styles.tabBtnLabeled,
          !activeFolder && activeLayoutTabId === layoutTabId && styles.tabBtnActive,
        )}
        data-tab-id={entry.id}
        {...(organizeMode ? {} : preloadOnIntent(entry.id))}
        onClick={organizeMode ? undefined : () => handleTabClick(layoutTabId)}
        onContextMenu={(event) => handleTabContextMenu(event)}
        onTouchStart={organizeMode ? undefined : (event) => handleTabTouchStart(event)}
        onTouchMove={organizeMode ? undefined : tabQuickMenu.onTouchMove}
        onTouchEnd={organizeMode ? undefined : tabQuickMenu.onTouchEnd}
        onTouchCancel={organizeMode ? undefined : tabQuickMenu.onTouchCancel}
        title={title}
      >
        <Icon size={20} strokeWidth={1.5} />
        {showTabLabels && <span className={styles.tabLabel}>{shortName}</span>}
        {extensionState?.badge && <span className={styles.tabBadge}>{extensionState.badge}</span>}
        <span data-spindle-mount="drawer_tab" data-spindle-scope={`drawer-tab:${entry.id}`} style={{ display: 'contents' }} />
      </button>
    )
  }

  if (!settingsLoaded) return null

  return (
    <>
      <AnimatePresence>
        {isMobile && drawerOpen && !pinned && (
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeDrawer}
          />
        )}
      </AnimatePresence>

      <div
        className={clsx(
          styles.wrapper,
          isCompact && styles.wrapperCompact,
          isRight ? styles.wrapperRight : styles.wrapperLeft,
          (drawerOpen || pinned) && styles.wrapperOpen,
          pinned && styles.wrapperPinned,
        )}
        style={{ '--drawer-panel-w': pinned ? '100%' : panelWidthCSS, ...(duoLayout ? duoPaneStyle(duoLayout.drawer, duoLayout) : {}) } as React.CSSProperties}
        role={pinned ? 'complementary' : undefined}
        aria-label={pinned ? t('viewportDrawer.navigation', { defaultValue: 'Navigation' }) : undefined}
        data-duo-drawer={pinned ? '' : undefined}
      >
        {!pinned && <button
          type="button"
          className={clsx(
            styles.drawerTab,
            isCompact && styles.drawerTabCompact,
            drawerOpen && styles.drawerTabActive,
            drawerTabDrag.isDragging && styles.drawerTabDragging,
          )}
          {...preloadOnIntent(activeTab)}
          {...drawerTabDrag.pointerHandlers}
          onClick={(event) => {
            if (drawerTabDrag.consumeSuppressedClick(event)) return
            if (drawerOpen) closeDrawer()
            else {
              preloadDrawerTab(activeTab)
              openDrawer()
            }
          }}
          style={{ marginTop: `${drawerTabDrag.verticalPosition}vh` }}
        >
          <div className={styles.tabIconBox}>
            <Sparkles size={isCompact ? 14 : 16} />
          </div>
        </button>}

        <div className={styles.drawer} ref={drawerRef} data-lumiverse-surface="viewport-drawer" data-liquid-glass-surface="">
          {!isMobile && drawerOpen && !pinned && (
            <div
              className={styles.resizeHandle}
              role="separator"
              aria-orientation="vertical"
              aria-label={ts('display.drawer.resizeLabel')}
              title={ts('display.drawer.resizeHint')}
              tabIndex={0}
              {...resize.handlers}
            />
          )}
          <DndContext
            sensors={sensors}
            modifiers={[lockSidebarDragToRail]}
            collisionDetection={(args) => {
              const inside = pointerWithin(args)
              return inside.length ? inside : args.pointerCoordinates ? [] : rectIntersection(args)
            }}
            onDragStart={onDragStart}
            onDragMove={updateDragHover}
            onDragOver={updateDragHover}
            onDragEnd={onDragEnd}
            onDragCancel={resetDrag}
          >
          <div className={clsx(styles.sidebar, organizeMode && styles.sidebarOrganizing)} ref={sidebarRef} data-spindle-mount="sidebar">
            <span data-spindle-mount="sidebar_top" data-spindle-scope="drawer:sidebar-top" style={{ display: 'contents' }} />
            <div className={clsx(
              styles.tabListWrap,
              tabListScroll.up && styles.tabListScrollUp,
              tabListScroll.down && styles.tabListScrollDown,
            )}>
              <div
                className={styles.tabList}
                ref={tabListRef}
                data-drawer-dragging={activeDragId || undefined}
                onContextMenuCapture={organizeMode ? (event) => {
                  // Catch native long-press menus on drag wrappers and extension tabs too.
                  event.preventDefault()
                  event.stopPropagation()
                } : undefined}
              >
                <SidebarEdgeDrop id={DRAWER_LAYOUT_ROOT_START_ID} enabled={dragEnabled || mobileArrange} />
                {layout.map((item) => {
                  if (item.type === 'divider') {
                    return <SidebarDividerDrop key={`divider:${item.id}`} id={item.id} label={item.label} enabled={dragEnabled || mobileArrange} hover={hover} />
                  }

                  if (item.type === 'tab') {
                    if (!isTabVisible(item.tabId)) return null
                    const id = drawerLayoutTabKey(item.tabId)
                    return <SidebarDragItem key={id} id={id} enabled={dragEnabled} mobileDrag={mobileDrag} hover={hover} suppressClick={suppressDraggedClick}>
                      {renderTabButton(item.tabId)}
                    </SidebarDragItem>
                  }

                  const visibleChildren = item.children.filter(isTabVisible)
                  const folderName = item.name.trim() || t('viewportDrawer.folder', { defaultValue: 'Folder' })
                  const folderExpanded = expandedFolderIds.has(item.id)
                  const folderActive = activeFolderId === item.id
                  const folderContainsActive = !activeFolder && item.children.includes(activeLayoutTabId)
                  const folderKey = drawerLayoutItemKey(item)

                  return (
                    <div key={folderKey} data-drawer-folder-slot="" className={clsx(styles.folderSlot, folderExpanded && styles.folderSlotOpen, hover?.id === folderKey && hover.side === 'inside' && styles.folderSlotDropInside)}>
                      <SidebarDragItem id={folderKey} enabled={dragEnabled} mobileDrag={mobileDrag} hover={hover} suppressClick={suppressDraggedClick}>
                        <button
                          type="button"
                          className={clsx(
                            styles.tabBtn,
                            styles.folderTabBtn,
                            showTabLabels && styles.tabBtnLabeled,
                            folderActive && styles.tabBtnActive,
                            folderContainsActive && styles.folderTabHasActiveChild,
                          )}
                          onClick={() => handleFolderClick(item.id)}
                          onContextMenu={(event) => handleTabContextMenu(event, item.id)}
                          onTouchStart={organizeMode ? undefined : (event) => handleTabTouchStart(event, item.id)}
                          onTouchMove={organizeMode ? undefined : tabQuickMenu.onTouchMove}
                          onTouchEnd={organizeMode ? undefined : tabQuickMenu.onTouchEnd}
                          onTouchCancel={organizeMode ? undefined : tabQuickMenu.onTouchCancel}
                          title={`${folderName} · ${visibleChildren.length} ${visibleChildren.length === 1 ? 'tab' : 'tabs'}`}
                          aria-expanded={folderExpanded}
                          aria-controls={`drawer-sidebar-folder-${item.id}`}
                        >
                          <DrawerFolderIcon icon={item.icon} customIcon={item.customIcon} size={20} strokeWidth={1.5} />
                          {showTabLabels && <span className={styles.tabLabel}>{folderName}</span>}
                        </button>
                      </SidebarDragItem>
                      {/* Retain the same buttons and Spindle mounts when collapsed. */}
                      <div id={`drawer-sidebar-folder-${item.id}`} className={styles.folderChildren} hidden={!folderExpanded} role="group" aria-label={folderName}>
                        {visibleChildren.map((tabId) => (
                          <SidebarDragItem key={tabId} id={drawerLayoutTabKey(tabId)} enabled={dragEnabled && folderExpanded} mobileDrag={folderExpanded ? mobileDrag : undefined} child hover={hover} suppressClick={suppressDraggedClick}>
                            {renderTabButton(tabId)}
                          </SidebarDragItem>
                        ))}
                      </div>
                    </div>
                  )
                })}
                <SidebarEdgeDrop id={DRAWER_LAYOUT_ROOT_END_ID} enabled={dragEnabled || mobileArrange} end />
              </div>
            </div>

            <div className={styles.sidebarBottom}>
              {organizeMode && (
                <button type="button" className={clsx(styles.tabBtn, styles.organizeDone)}
                  onClick={() => setOrganizeMode(false)}
                  title={t('viewportDrawer.arrangeDone', { defaultValue: 'Done arranging icons' })}
                  aria-label={t('viewportDrawer.arrangeDone', { defaultValue: 'Done arranging icons' })}>
                  <Check size={18} />
                </button>
              )}
              <span data-spindle-mount="sidebar_bottom" data-spindle-scope="drawer:sidebar-bottom" style={{ display: 'contents' }} />
              <button
                type="button"
                className={styles.tabBtn}
                onClick={() => openSettings()}
                title={ts('title', { defaultValue: 'Settings' })}
              >
                <Settings size={18} />
              </button>
            </div>
          </div>
          </DndContext>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelHeaderMain}>
                <h2 className={styles.panelTitle}>{panelTitle}</h2>

                {!activeFolder && activeTabConfig.guide && (
                  <button
                    type="button"
                    className={styles.guideButton}
                    onClick={(event) => {
                      if (activeTabConfig.guide) openGuide(activeTabConfig.guide, activeTabTitle, event.currentTarget)
                    }}
                    aria-label={`Open guide for ${activeTabTitle}`}
                    title="Open guide"
                  >
                    <CircleHelp size={15} strokeWidth={1.7} />
                  </button>
                )}
              </div>

              <span className={styles.headerActions}>
                <span data-spindle-mount="drawer_header_actions" data-spindle-scope="drawer:header-actions" style={{ display: 'contents' }} />
              </span>
              {!pinned && <CloseButton onClick={closeDrawer} />}
            </div>
            <div
              className={clsx(
                styles.panelContent,
                !activeFolder && (activeTab === 'council' || activeTab === 'loom' || activeTab === 'lumi' || activeTab === 'browser' || activeTab === 'lorebook') && styles.panelContentFull,
              )}
              ref={panelContentRef}
            >
              {activeFolder?.type === 'folder' ? (
                <div className={styles.folderPanel}>
                  <div className={styles.folderToolbar}>
                    <span>{activeFolderTabs.length} {activeFolderTabs.length === 1 ? 'tab' : 'tabs'}</span>
                    <div className={styles.folderToolbarActions}>
                      <div className={styles.folderViewToggle} role="group" aria-label={t('viewportDrawer.folderView', { defaultValue: 'Folder view' })}>
                        <button
                          type="button"
                          className={clsx(styles.folderViewButton, activeFolderView === 'list' && styles.folderViewButtonActive)}
                          onClick={() => setFolderView('list')}
                          title={t('viewportDrawer.listView', { defaultValue: 'List view' })}
                          aria-label={t('viewportDrawer.listView', { defaultValue: 'List view' })}
                          aria-pressed={activeFolderView === 'list'}
                        >
                          <List size={14} />
                        </button>
                        <button
                          type="button"
                          className={clsx(styles.folderViewButton, activeFolderView === 'grid' && styles.folderViewButtonActive)}
                          onClick={() => setFolderView('grid')}
                          title={t('viewportDrawer.gridView', { defaultValue: 'Grid view' })}
                          aria-label={t('viewportDrawer.gridView', { defaultValue: 'Grid view' })}
                          aria-pressed={activeFolderView === 'grid'}
                        >
                          <LayoutGrid size={14} />
                        </button>
                      </div>
                      <button type="button" className={styles.folderManageButton}
                        onClick={() => openModal('configureTabs', { focusFolderId: activeFolder.id })}>
                        {t('viewportDrawer.editFolder', { defaultValue: 'Customize Folder' })}
                      </button>
                    </div>
                  </div>

                  {activeFolderTabs.length ? (
                    <div className={clsx(styles.folderList, activeFolderView === 'grid' && styles.folderGrid)}>
                      {activeFolderTabs.map(({ layoutTabId, entry }) => {
                        const Icon = entry.tabIcon
                        return (
                          <button
                            key={layoutTabId}
                            type="button"
                            className={styles.folderTile}
                            {...preloadOnIntent(entry.id)}
                            onClick={() => handleTabClick(layoutTabId)}
                          >
                            <span className={styles.folderTileIcon}><Icon size={19} strokeWidth={1.6} /></span>
                            <span className={styles.folderTileCopy}>
                              <strong>{translateDrawerField(entry.id, 'tabName', entry.tabName)}</strong>
                              <span>{entry.tabDescription}</span>
                            </span>
                            <ChevronRight size={15} className={styles.folderTileChevron} />
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className={styles.folderPanelEmpty}>
                      {t('viewportDrawer.folderEmpty', { defaultValue: 'This folder has no visible tabs right now.' })}
                    </div>
                  )}
                </div>
              ) : (
                <TabPanelContent tabId={activeTab} location={{ kind: 'main-drawer' }} />
              )}
            </div>
          </div>
          <span data-spindle-mount="drawer_footer" data-spindle-scope="drawer:footer" style={{ display: 'contents' }} />
        </div>
      </div>

      <ContextMenu
        position={contextMenu}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </>
  )
}
