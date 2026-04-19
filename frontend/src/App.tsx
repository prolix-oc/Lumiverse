import { useEffect, useMemo } from 'react'
import { Outlet } from 'react-router'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import { useWebSocket } from '@/ws/useWebSocket'
import { useStore } from '@/store'
import { useThemeApplicator } from '@/hooks/useThemeApplicator'
import { useCharacterTheme } from '@/hooks/useCharacterTheme'
import { useCustomCSSApplicator } from '@/hooks/useCustomCSSApplicator'
import { useAppInit } from '@/hooks/useAppInit'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import AuthGuard from '@/components/auth/AuthGuard'
import ViewportDrawer from '@/components/panels/ViewportDrawer'
import ModalContainer from '@/components/modals/ModalContainer'
import SpindleUIManager from '@/components/spindle/SpindleUIManager'
import ToastContainer from '@/components/shared/ToastContainer'
import ChatHeads from '@/components/chat-heads/ChatHeads'
import useIsMobile from '@/hooks/useIsMobile'
import { useBadging } from '@/hooks/useBadging'
import { useTTSAutoPlay } from '@/hooks/useTTSAutoPlay'
import { useAutoSummarization } from '@/hooks/useAutoSummarization'
import styles from './App.module.css'

export default function App() {
  useWebSocket()
  useThemeApplicator()
  useCharacterTheme()
  useCustomCSSApplicator()
  useAppInit()
  useBadging()
  useTTSAutoPlay()
  useAutoSummarization()

  const isMobile = useIsMobile()
  const dockPanels = useStore((s) => s.dockPanels)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)

  const dockInsets = useMemo(() => {
    let left = 0, right = 0, top = 0, bottom = 0
    for (const p of dockPanels) {
      if (hiddenPlacements.includes(p.id)) continue
      const size = p.collapsed ? 36 : p.size
      // On mobile, left/right docks render as top sheets (bottom conflicts with input area)
      const edge = isMobile && (p.edge === 'left' || p.edge === 'right') ? 'top' : p.edge
      switch (edge) {
        case 'left': left = Math.max(left, size); break
        case 'right': right = Math.max(right, size); break
        case 'top': top = Math.max(top, size); break
        case 'bottom': bottom = Math.max(bottom, size); break
      }
    }
    return { left, right, top, bottom }
  }, [dockPanels, hiddenPlacements, isMobile])

  const loadSettings = useStore((s) => s.loadSettings)
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const openDrawer = useStore((s) => s.openDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const setActiveProfile = useStore((s) => s.setActiveProfile)
  const setActiveImageGenConnection = useStore((s) => s.setActiveImageGenConnection)
  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated, loadSettings])

  // Capture BYOP API key returned in URL hash globally so it can be consumed
  // later when the relevant connection form is opened.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash) return
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    const byopApiKey = params.get('api_key')
    if (!byopApiKey) return

    sessionStorage.setItem('pollinations_byop_returned_api_key', byopApiKey)
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`)
  }, [])

  // After BYOP redirect, bring the user directly to Connections and focus
  // the intended profile when editing an existing one.
  useEffect(() => {
    const returnedKey = sessionStorage.getItem('pollinations_byop_returned_api_key')
    const pendingRaw = sessionStorage.getItem('pollinations_byop_pending')
    if (!returnedKey || !pendingRaw) return

    try {
      const pending = JSON.parse(pendingRaw) as {
        target?: string
        provider?: string
        connectionId?: string | null
      }
      if (pending.provider !== 'pollinations') return

      openDrawer('connections')
      setDrawerTab('connections')

      if (pending.target === 'connections' && pending.connectionId) {
        setActiveProfile(pending.connectionId)
      }
      if (pending.target === 'image-gen-connections' && pending.connectionId) {
        setActiveImageGenConnection(pending.connectionId)
      }
    } catch {
      // ignore malformed pending payload
    }
  }, [openDrawer, setDrawerTab, setActiveProfile, setActiveImageGenConnection])

  // Global Cmd+K / Ctrl+K shortcut to open the command palette
  const openCommandPalette = useStore((s) => s.openCommandPalette)
  const closeCommandPalette = useStore((s) => s.closeCommandPalette)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (commandPaletteOpen) {
          closeCommandPalette()
        } else {
          openCommandPalette()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [commandPaletteOpen, openCommandPalette, closeCommandPalette])

  // Apply modal-width mode as a root CSS variable so all modals can reference it
  const modalWidthMode = useStore((s) => s.modalWidthMode)
  const modalMaxWidth = useStore((s) => s.modalMaxWidth)
  useEffect(() => {
    const root = document.documentElement
    switch (modalWidthMode) {
      case 'comfortable':
        root.style.setProperty('--lumiverse-content-max-width', '1000px')
        break
      case 'compact':
        root.style.setProperty('--lumiverse-content-max-width', '760px')
        break
      case 'custom':
        root.style.setProperty('--lumiverse-content-max-width', `${modalMaxWidth}px`)
        break
      default:
        root.style.removeProperty('--lumiverse-content-max-width')
    }
  }, [modalWidthMode, modalMaxWidth])

  return (
    <AuthGuard>
      <LazyMotion features={domAnimation} strict={false}>
        <MotionConfig reducedMotion="user">
          <div
            className={styles.app}
            style={{
              '--spindle-dock-left': `${dockInsets.left}px`,
              '--spindle-dock-right': `${dockInsets.right}px`,
              '--spindle-dock-top': `${dockInsets.top}px`,
              '--spindle-dock-bottom': `${dockInsets.bottom}px`,
            } as React.CSSProperties}
          >
            <ErrorBoundary label="App">
              <main className={styles.main}>
                <Outlet />
              </main>
              <ViewportDrawer />
              <ModalContainer />
              <SpindleUIManager />
              <ToastContainer />
              <ChatHeads />
            </ErrorBoundary>
          </div>
        </MotionConfig>
      </LazyMotion>
    </AuthGuard>
  )
}
