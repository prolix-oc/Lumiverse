import { useRef, useState, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Sparkles, Settings, Puzzle } from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import { CloseButton } from '@/components/shared/CloseButton'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import { DRAWER_TABS, adaptExtensionTabs, sanitizeHiddenDrawerTabIds } from '@/lib/drawer-tab-registry'
import styles from './ViewportDrawer.module.css'
import DOMPurify from 'dompurify'
import clsx from 'clsx'

function ExtensionTabContent({ tabId }: { tabId: string }) {
  const drawerTabs = useStore((s) => s.drawerTabs)
  const tab = drawerTabs.find((t) => t.id === tabId)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current && tab?.root && !containerRef.current.contains(tab.root)) {
      containerRef.current.replaceChildren(tab.root)
    }
  }, [tab])

  if (!tab) return null
  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

export default function ViewportDrawer() {
  const drawerOpen = useStore((s) => s.drawerOpen)
  const drawerTab = useStore((s) => s.drawerTab)
  const openDrawer = useStore((s) => s.openDrawer)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const openSettings = useStore((s) => s.openSettings)
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const isGroupChat = useStore((s) => s.isGroupChat)

  const isMobile = useIsMobile()
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const [tabListScroll, setTabListScroll] = useState({ up: false, down: false })
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)

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

  const showTabLabels = drawerSettings.showTabLabels ?? false
  const hiddenTabIds = sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)
  const hiddenTabIdsSet = new Set(hiddenTabIds)

  const updateDrawer = useCallback(
    (partial: Partial<typeof drawerSettings>) => {
      setSetting('drawerSettings', { ...drawerSettings, ...partial })
    },
    [drawerSettings, setSetting]
  )

  // Merge built-in tabs with dynamic extension tabs
  const extensionEntries = adaptExtensionTabs(drawerTabs).map((entry) => ({
    ...entry,
    component: () => <ExtensionTabContent tabId={entry.id} />,
  }))
  const visibleBuiltInTabs = DRAWER_TABS.filter((tab) => !hiddenTabIdsSet.has(tab.id))
  const visibleDrawerTabs = drawerTabs.filter((tab) => !hiddenTabIdsSet.has(tab.id))
  const visibleExtensionEntries = extensionEntries.filter((entry) => !hiddenTabIdsSet.has(entry.id))
  const requestedActiveTab = drawerTab || 'profile'
  const allTabs = [...visibleBuiltInTabs, ...visibleExtensionEntries]
  const activeTab = allTabs.some((tab) => tab.id === requestedActiveTab) ? requestedActiveTab : 'profile'
  const activeTabConfig = allTabs.find((t) => t.id === activeTab) || DRAWER_TABS[0]

  useEffect(() => {
    if (drawerTab && drawerTab !== activeTab) {
      setDrawerTab(activeTab)
    }
  }, [drawerTab, activeTab, setDrawerTab])

  const handleTabClick = useCallback(
    (tabId: string) => {
      setDrawerTab(tabId)
      openDrawer(tabId)
    },
    [setDrawerTab, openDrawer]
  )

  const tabQuickMenu = useLongPress({
    onLongPress: (pos) => setContextMenu(pos),
  })

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) return
      tabQuickMenu.onContextMenu(e)
    },
    [tabQuickMenu]
  )

  const contextMenuItems: ContextMenuEntry[] = [
    {
      key: 'toggle-labels',
      label: showTabLabels ? 'Hide tab labels' : 'Show tab labels',
      danger: showTabLabels,
      onClick: () => {
        updateDrawer({ showTabLabels: !showTabLabels })
        setContextMenu(null)
      },
    },
    {
      key: 'configure-tabs',
      label: 'Configure Tabs',
      onClick: () => {
        setContextMenu(null)
        openModal('configureTabs')
      },
    },
  ]

  const isRight = drawerSettings.side === 'right'
  const isCompact = drawerSettings.tabSize === 'compact'

  const panelWidthCSS = (() => {
    switch (drawerSettings.panelWidthMode) {
      case 'stChat': return '376px'
      case 'custom': return `${Math.max(20, Math.min(80, drawerSettings.customPanelWidth))}vw`
      default: return 'min(420px, calc(100vw - 64px))'
    }
  })()

  return (
    <>
      <AnimatePresence>
        {isMobile && drawerOpen && (
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
          isRight ? styles.wrapperRight : styles.wrapperLeft,
          drawerOpen && styles.wrapperOpen,
        )}
        style={{ '--drawer-panel-w': panelWidthCSS } as React.CSSProperties}
      >
        {/* Flush drawer tab */}
        <button
          type="button"
          className={clsx(
            styles.drawerTab,
            isCompact && styles.drawerTabCompact,
            drawerOpen && styles.drawerTabActive,
          )}
          onClick={() => (drawerOpen ? closeDrawer() : openDrawer())}
          style={{ marginTop: `${drawerSettings.verticalPosition}vh` }}
        >
          <div className={styles.tabIconBox}>
            <Sparkles size={isCompact ? 14 : 16} />
          </div>
        </button>

        {/* Drawer panel */}
        <div className={styles.drawer}>
          <div className={styles.sidebar} ref={sidebarRef} data-spindle-mount="sidebar">
            <div className={clsx(
              styles.tabListWrap,
              tabListScroll.up && styles.tabListScrollUp,
              tabListScroll.down && styles.tabListScrollDown,
            )}>
              <div className={styles.tabList} ref={tabListRef}>
                {visibleBuiltInTabs.map((tab) => {
                  const Icon = tab.tabIcon
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={clsx(styles.tabBtn, showTabLabels && styles.tabBtnLabeled, activeTab === tab.id && styles.tabBtnActive)}
                      onClick={() => handleTabClick(tab.id)}
                      onContextMenu={handleTabContextMenu}
                      onTouchStart={tabQuickMenu.onTouchStart}
                      onTouchMove={tabQuickMenu.onTouchMove}
                      onTouchEnd={tabQuickMenu.onTouchEnd}
                      title={tab.tabName}
                    >
                      <Icon size={20} strokeWidth={1.5} />
                      {showTabLabels && <span className={styles.tabLabel}>{tab.shortName}</span>}
                    </button>
                  )
                })}

                {visibleDrawerTabs.length > 0 && (
                  <>
                    <div className={styles.tabDivider} />
                    {visibleDrawerTabs.map((dt) => {
                      const extEntry = visibleExtensionEntries.find((e) => e.id === dt.id)
                      return (
                        <button
                          key={dt.id}
                          type="button"
                          className={clsx(styles.tabBtn, styles.tabBtnExtension, showTabLabels && styles.tabBtnLabeled, activeTab === dt.id && styles.tabBtnActive)}
                          onClick={() => handleTabClick(dt.id)}
                          onContextMenu={handleTabContextMenu}
                          onTouchStart={tabQuickMenu.onTouchStart}
                          onTouchMove={tabQuickMenu.onTouchMove}
                          onTouchEnd={tabQuickMenu.onTouchEnd}
                          title={dt.title}
                        >
                          {dt.iconSvg ? (
                            <span
                              className={styles.extIconSvg}
                              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(dt.iconSvg) }}
                            />
                          ) : dt.iconUrl ? (
                            <img src={dt.iconUrl} alt="" width={20} height={20} className={styles.extIconImg} />
                          ) : (
                            <Puzzle size={20} strokeWidth={1.5} />
                          )}
                          {showTabLabels && extEntry && <span className={styles.tabLabel}>{extEntry.shortName}</span>}
                          {dt.badge && <span className={styles.tabBadge}>{dt.badge}</span>}
                        </button>
                      )
                    })}
                  </>
                )}
              </div>
            </div>

            <div className={styles.sidebarBottom}>
              <button
                type="button"
                className={styles.tabBtn}
                onClick={() => openSettings()}
                title="Settings"
              >
                <Settings size={18} />
              </button>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>
                {activeTab === 'profile' && isGroupChat ? 'Group' : (activeTabConfig?.tabHeaderTitle ?? activeTabConfig?.tabName ?? 'Panel')}
              </h2>
              <CloseButton onClick={closeDrawer} />
            </div>
            <div className={clsx(styles.panelContent, (activeTab === 'loom' || activeTab === 'lumi' || activeTab === 'browser') && styles.panelContentFull)}>
              <ErrorBoundary key={activeTab} label={activeTabConfig?.tabName}>
                {activeTabConfig?.component()}
              </ErrorBoundary>
            </div>
          </div>
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
