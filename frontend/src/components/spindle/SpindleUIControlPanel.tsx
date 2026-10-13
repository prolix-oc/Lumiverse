import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react'
import { IconApps } from '@tabler/icons-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { resolveDockPanelEdge } from '@/lib/spindle/dock-placement'
import styles from './SpindleUIControlPanel.module.css'
import clsx from 'clsx'
import { filterEnabledFrontendContributions } from '@/lib/spindle/frontend-extension-availability'

type SurfaceTab = 'all' | 'sidebar' | 'widget' | 'dock'
type SurfaceKind = SurfaceTab | 'app'

const COLLAPSE_STORAGE_KEY = 'lumiverse:spindle:extension-ui-collapsed'
const TAB_STORAGE_KEY = 'lumiverse:spindle:extension-ui-tab'

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true'
}

function readTabPreference(): SurfaceTab {
  if (typeof window === 'undefined') return 'all'
  const value = window.localStorage.getItem(TAB_STORAGE_KEY)
  return value === 'sidebar' || value === 'widget' || value === 'dock' ? value : 'all'
}

export default function SpindleUIControlPanel() {
  const { t } = useTranslation('shared', { keyPrefix: 'spindle' })
  const drawerTabs = useStore((s) => s.drawerTabs)
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const extensions = useStore((s) => s.extensions)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const togglePlacementVisibility = useStore((s) => s.togglePlacementVisibility)
  const showAllPlacements = useStore((s) => s.showAllPlacements)
  const hideAllPlacements = useStore((s) => s.hideAllPlacements)
  const dockPanelDesktopSide = useStore((s) => s.spindleSettings.dockPanelDesktopSide)
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(readCollapsedPreference)
  const [activeTab, setActiveTab] = useState<SurfaceTab>(readTabPreference)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(collapsed))
  }, [collapsed])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(TAB_STORAGE_KEY, activeTab)
  }, [activeTab])

  const enabledDrawerTabs = filterEnabledFrontendContributions(drawerTabs, extensions)
  const enabledFloatWidgets = filterEnabledFrontendContributions(floatWidgets, extensions)
  const enabledDockPanels = filterEnabledFrontendContributions(dockPanels, extensions)
  const enabledAppMounts = filterEnabledFrontendContributions(appMounts, extensions)

  const allItems = useMemo(() => [
    ...enabledDrawerTabs.map((tab) => ({
      id: tab.id,
      label: tab.title,
      kind: t('drawerTab'),
      surface: 'sidebar' as SurfaceKind,
    })),
    ...enabledFloatWidgets.map((widget) => ({
      id: widget.id,
      label: widget.tooltip || t('floatWidget'),
      kind: t('floatWidget'),
      surface: 'widget' as SurfaceKind,
    })),
    ...enabledDockPanels.map((panel) => ({
      id: panel.id,
      label: panel.title,
      kind: t('dockPanel', { edge: resolveDockPanelEdge(panel.edge, dockPanelDesktopSide, isMobile) }),
      surface: 'dock' as SurfaceKind,
    })),
    ...enabledAppMounts.map((mount) => ({
      id: mount.id,
      label: t('appMount'),
      kind: t('appMount'),
      surface: 'app' as SurfaceKind,
    })),
  ], [
    dockPanelDesktopSide,
    enabledAppMounts,
    enabledDockPanels,
    enabledDrawerTabs,
    enabledFloatWidgets,
    isMobile,
    t,
  ])

  if (allItems.length === 0) return null

  const visibleItems = activeTab === 'all'
    ? allItems
    : allItems.filter((item) => item.surface === activeTab)

  const counts = {
    all: allItems.length,
    sidebar: allItems.filter((item) => item.surface === 'sidebar').length,
    widget: allItems.filter((item) => item.surface === 'widget').length,
    dock: allItems.filter((item) => item.surface === 'dock').length,
  }

  const handleShowVisible = () => {
    if (activeTab === 'all') {
      showAllPlacements()
      return
    }
    visibleItems.forEach((item) => {
      if (hiddenPlacements.includes(item.id)) togglePlacementVisibility(item.id)
    })
  }

  const handleHideVisible = () => {
    if (activeTab === 'all') {
      hideAllPlacements()
      return
    }
    visibleItems.forEach((item) => {
      if (!hiddenPlacements.includes(item.id)) togglePlacementVisibility(item.id)
    })
  }

  const tabs: Array<{ id: SurfaceTab; label: string; count: number }> = [
    { id: 'all', label: t('surfaceAll', { defaultValue: 'All' }), count: counts.all },
    { id: 'sidebar', label: t('surfaceSidebar', { defaultValue: 'Sidebar' }), count: counts.sidebar },
    { id: 'widget', label: t('surfaceWidget', { defaultValue: 'Widget' }), count: counts.widget },
    { id: 'dock', label: t('surfaceDock', { defaultValue: 'Dock' }), count: counts.dock },
  ]

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <IconApps size={13} />
          <span className={styles.headerLabel}>{t('extensionUi', { count: allItems.length })}</span>
        </button>
        {!collapsed && (
          <div className={styles.headerActions}>
            <button className={styles.smallBtn} onClick={handleShowVisible} title={t('showAll')}>
              <Eye size={12} /> {t('show')}
            </button>
            <button className={styles.smallBtn} onClick={handleHideVisible} title={t('hideAll')}>
              <EyeOff size={12} /> {t('hide')}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <div className={styles.tabs} role="tablist" aria-label={t('extensionUi', { count: allItems.length })}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={clsx(styles.tabBtn, activeTab === tab.id && styles.tabBtnActive)}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                <span className={styles.tabCount}>{tab.count}</span>
              </button>
            ))}
          </div>

          {visibleItems.length === 0 ? (
            <div className={styles.emptyTab}>
              {t('noSurfaceItems', { defaultValue: 'No extension UI in this category.' })}
            </div>
          ) : (
            <div className={styles.list}>
              {visibleItems.map((item) => {
                const isHidden = hiddenPlacements.includes(item.id)
                return (
                  <div key={item.id} className={clsx(styles.item, isHidden && styles.itemHidden)}>
                    <div className={styles.itemInfo}>
                      <span className={styles.itemLabel}>{item.label}</span>
                      <span className={styles.itemMeta}>{item.kind}</span>
                    </div>
                    <button
                      className={styles.toggleBtn}
                      onClick={() => togglePlacementVisibility(item.id)}
                      title={isHidden ? t('show') : t('hide')}
                      aria-label={`${isHidden ? t('show') : t('hide')} ${item.label}`}
                    >
                      {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
