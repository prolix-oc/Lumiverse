import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  User, Drama, Wand2, Link2, Package, Zap,
  Users, PenTool, Sparkles, FileText, Brain, ScrollText,
  MessageCircle, Image, Palette, Settings, X, Library, Puzzle,
  GitFork, Globe, MessageSquareReply, GitBranch, Wallpaper, Replace
} from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import CharacterProfile from './CharacterProfile'
import CharacterBrowser from './CharacterBrowser'
import PersonaManager from './PersonaManager'
import ConnectionManager from './ConnectionManager'
import PresetManager from './PresetManager'
import LoomBuilder from './LoomBuilder'
import LumiBuilder from './LumiBuilder'
import SummaryEditor from './SummaryEditor'
import ThemePanel from './ThemePanel'
import WorldBookPanel from './world-book/WorldBookPanel'
import SpindlePanel from './SpindlePanel'
import PackBrowser from './pack-browser/PackBrowser'
import ContentWorkshop from './creator-workshop/ContentWorkshop'
import CouncilManager from './CouncilManager'
import CouncilFeedback from './CouncilFeedback'
import WorldInfoFeedback from './WorldInfoFeedback'
import OOCPanel from './OOCPanel'
import PromptPanel from './PromptPanel'
import ImageGenPanel from './ImageGenPanel'
import WallpaperPanel from './WallpaperPanel'
import BranchTreePanel from './BranchTreePanel'
import RegexPanel from './RegexPanel'
import styles from './ViewportDrawer.module.css'
import clsx from 'clsx'

interface Tab {
  id: string
  icon: any
  label: string
  component: () => ReactNode
}

function StubPanel({ title }: { title: string }) {
  return (
    <div className={styles.stubPanel}>
      <p>{title}</p>
      <span>Coming soon</span>
    </div>
  )
}

const TABS: Tab[] = [
  { id: 'profile', icon: User, label: 'Profile', component: () => <CharacterProfile /> },
  { id: 'presets', icon: Wand2, label: 'Reasoning', component: () => <PresetManager /> },
  { id: 'loom', icon: GitFork, label: 'Loom', component: () => <LoomBuilder compact /> },
  { id: 'lumi', icon: Zap, label: 'Lumi', component: () => <LumiBuilder compact /> },
  { id: 'connections', icon: Link2, label: 'Connections', component: () => <ConnectionManager /> },
  { id: 'browser', icon: Package, label: 'Browser', component: () => <PackBrowser /> },
  { id: 'characters', icon: Users, label: 'Characters', component: () => <CharacterBrowser /> },
  { id: 'personas', icon: Drama, label: 'Personas', component: () => <PersonaManager /> },
  { id: 'lorebook', icon: Library, label: 'Lorebook', component: () => <WorldBookPanel /> },
  { id: 'create', icon: PenTool, label: 'Create', component: () => <ContentWorkshop /> },
  { id: 'ooc', icon: MessageCircle, label: 'OOC', component: () => <OOCPanel /> },
  { id: 'prompt', icon: FileText, label: 'Prompt', component: () => <PromptPanel /> },
  { id: 'council', icon: Brain, label: 'Council', component: () => <CouncilManager /> },
  { id: 'summary', icon: ScrollText, label: 'Summary', component: () => <SummaryEditor /> },
{ id: 'feedback', icon: MessageSquareReply, label: 'Feedback', component: () => <CouncilFeedback /> },
  { id: 'worldinfo', icon: Globe, label: 'World Info', component: () => <WorldInfoFeedback /> },
  { id: 'imagegen', icon: Image, label: 'Image Gen', component: () => <ImageGenPanel /> },
  { id: 'wallpaper', icon: Wallpaper, label: 'Wallpaper', component: () => <WallpaperPanel /> },
  { id: 'regex', icon: Replace, label: 'Regex', component: () => <RegexPanel /> },
  { id: 'branches', icon: GitBranch, label: 'Branches', component: () => <BranchTreePanel /> },
  { id: 'theme', icon: Palette, label: 'Theme', component: () => <ThemePanel /> },
  { id: 'spindle', icon: Puzzle, label: 'Extensions', component: () => <SpindlePanel /> },
]

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
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)

  const isMobile = useIsMobile()
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const [tabListScroll, setTabListScroll] = useState({ up: false, down: false })

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

  // Merge built-in tabs with dynamic extension tabs
  const extensionTabs: Tab[] = drawerTabs.map((dt) => ({
    id: dt.id,
    icon: Puzzle, // fallback; we render custom icons separately
    label: dt.title,
    component: () => <ExtensionTabContent tabId={dt.id} />,
  }))

  const activeTab = drawerTab || 'profile'
  const allTabs = [...TABS, ...extensionTabs]
  const activeTabConfig = allTabs.find((t) => t.id === activeTab) || TABS.find((t) => t.id === activeTab)

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (drawerOpen && activeTab === tabId) {
        closeDrawer()
      } else {
        setDrawerTab(tabId)
        openDrawer(tabId)
      }
    },
    [drawerOpen, activeTab, closeDrawer, setDrawerTab, openDrawer]
  )

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
                {TABS.map((tab) => {
                  const Icon = tab.icon
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={clsx(styles.tabBtn, activeTab === tab.id && styles.tabBtnActive)}
                      onClick={() => handleTabClick(tab.id)}
                      title={tab.label}
                    >
                      <Icon size={20} strokeWidth={1.5} />
                    </button>
                  )
                })}

                {drawerTabs.length > 0 && (
                  <>
                    <div className={styles.tabDivider} />
                    {drawerTabs.map((dt) => (
                      <button
                        key={dt.id}
                        type="button"
                        className={clsx(styles.tabBtn, styles.tabBtnExtension, activeTab === dt.id && styles.tabBtnActive)}
                        onClick={() => handleTabClick(dt.id)}
                        title={dt.title}
                      >
                        {dt.iconSvg ? (
                          <span
                            className={styles.extIconSvg}
                            dangerouslySetInnerHTML={{ __html: dt.iconSvg }}
                          />
                        ) : dt.iconUrl ? (
                          <img src={dt.iconUrl} alt="" width={20} height={20} className={styles.extIconImg} />
                        ) : (
                          <Puzzle size={20} strokeWidth={1.5} />
                        )}
                        {dt.badge && <span className={styles.tabBadge}>{dt.badge}</span>}
                      </button>
                    ))}
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
              <h2 className={styles.panelTitle}>{activeTabConfig?.label || 'Panel'}</h2>
              <button type="button" className={styles.closeBtn} onClick={closeDrawer}>
                <X size={16} />
              </button>
            </div>
            <div className={clsx(styles.panelContent, (activeTab === 'loom' || activeTab === 'lumi' || activeTab === 'browser') && styles.panelContentFull)}>
              <ErrorBoundary label={activeTabConfig?.label}>
                {activeTabConfig?.component()}
              </ErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
