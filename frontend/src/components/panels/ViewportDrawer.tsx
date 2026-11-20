import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronRight, CircleHelp, LayoutGrid, List, Settings, Sparkles } from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { CloseButton } from '@/components/shared/CloseButton'
import { GuideViewer } from '@/components/shared/GuideViewer'
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
  drawerLayoutItemKey,
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
  const [guideOpen, setGuideOpen] = useState(false)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
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
    setGuideOpen(false)
  }, [activeTab, activeFolderId])

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
    setActiveFolderId(folderId)
    openDrawer()
  }, [openDrawer])

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
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) return
      tabQuickMenu.onContextMenu(e)
    },
    [tabQuickMenu],
  )

  const contextMenuItems: ContextMenuEntry[] = [
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

  const renderTabButton = (layoutTabId: string, options?: { organizedAnchor?: boolean }) => {
    const entry = tabEntryById.get(layoutTabId)
    if (!entry || !isTabVisible(layoutTabId)) return null
    const Icon = entry.tabIcon
    const extensionState = extensionStateById.get(layoutTabId)
    const title = translateDrawerField(entry.id, 'tabName', entry.tabName)
    const shortName = translateDrawerField(entry.id, 'shortName', entry.shortName)
    const organizedAnchor = options?.organizedAnchor ?? false

    return (
      <button
        key={`${organizedAnchor ? 'organized-anchor' : 'tab'}:${layoutTabId}`}
        type="button"
        className={clsx(
          styles.tabBtn,
          extensionIds.has(layoutTabId) && styles.tabBtnExtension,
          showTabLabels && styles.tabBtnLabeled,
          !organizedAnchor && !activeFolder && activeLayoutTabId === layoutTabId && styles.tabBtnActive,
          organizedAnchor && styles.organizedTabAnchor,
        )}
        data-tab-id={entry.id}
        {...(organizedAnchor ? {} : preloadOnIntent(entry.id))}
        onClick={organizedAnchor ? undefined : () => handleTabClick(layoutTabId)}
        onContextMenu={organizedAnchor ? undefined : handleTabContextMenu}
        onTouchStart={organizedAnchor ? undefined : tabQuickMenu.onTouchStart}
        onTouchMove={organizedAnchor ? undefined : tabQuickMenu.onTouchMove}
        onTouchEnd={organizedAnchor ? undefined : tabQuickMenu.onTouchEnd}
        onTouchCancel={organizedAnchor ? undefined : tabQuickMenu.onTouchCancel}
        title={title}
        tabIndex={organizedAnchor ? -1 : undefined}
        aria-hidden={organizedAnchor || undefined}
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
          <div className={styles.sidebar} ref={sidebarRef} data-spindle-mount="sidebar">
            <span data-spindle-mount="sidebar_top" data-spindle-scope="drawer:sidebar-top" style={{ display: 'contents' }} />
            <div className={clsx(
              styles.tabListWrap,
              tabListScroll.up && styles.tabListScrollUp,
              tabListScroll.down && styles.tabListScrollDown,
            )}>
              <div className={styles.tabList} ref={tabListRef}>
                {layout.map((item) => {
                  if (item.type === 'divider') {
                    return (
                      <div
                        key={`divider:${item.id}`}
                        className={styles.tabDivider}
                        title={item.label || undefined}
                        aria-hidden="true"
                      />
                    )
                  }

                  if (item.type === 'tab') return renderTabButton(item.tabId)

                  const visibleChildren = item.children.filter(isTabVisible)
                  if (!visibleChildren.length) return null
                  const folderName = item.name.trim() || t('viewportDrawer.folder', { defaultValue: 'Folder' })
                  const folderActive = activeFolderId === item.id || (!activeFolder && item.children.includes(activeLayoutTabId))

                  return (
                    <div key={`folder:${item.id}`} className={styles.folderSlot}>
                      <button
                        type="button"
                        className={clsx(
                          styles.tabBtn,
                          styles.folderTabBtn,
                          showTabLabels && styles.tabBtnLabeled,
                          folderActive && styles.tabBtnActive,
                        )}
                        onClick={() => handleFolderClick(item.id)}
                        onContextMenu={handleTabContextMenu}
                        onTouchStart={tabQuickMenu.onTouchStart}
                        onTouchMove={tabQuickMenu.onTouchMove}
                        onTouchEnd={tabQuickMenu.onTouchEnd}
                        onTouchCancel={tabQuickMenu.onTouchCancel}
                        title={`${folderName} · ${visibleChildren.length} ${visibleChildren.length === 1 ? 'tab' : 'tabs'}`}
                      >
                        <DrawerFolderIcon icon={item.icon} customIcon={item.customIcon} size={20} strokeWidth={1.5} />
                        {showTabLabels && <span className={styles.tabLabel}>{folderName}</span>}
                      </button>
                      <div className={styles.organizedTabAnchors} aria-hidden="true">
                        {visibleChildren.map((tabId) => renderTabButton(tabId, { organizedAnchor: true }))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={styles.sidebarBottom}>
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

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelHeaderMain}>
                <h2 className={styles.panelTitle}>{panelTitle}</h2>

                {!activeFolder && activeTabConfig.guide && (
                  <button
                    type="button"
                    className={styles.guideButton}
                    onClick={() => setGuideOpen(true)}
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
                      <button type="button" className={styles.folderManageButton} onClick={() => openModal('configureTabs')}>
                        {t('viewportDrawer.configureTabs')}
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

      {!activeFolder && activeTabConfig.guide && (
        <GuideViewer
          isOpen={guideOpen}
          onClose={() => setGuideOpen(false)}
          guide={activeTabConfig.guide}
          title={activeTabTitle}
        />
      )}

      <ContextMenu
        position={contextMenu}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </>
  )
}
