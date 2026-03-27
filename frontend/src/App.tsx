import { useEffect, useMemo } from 'react'
import { Outlet } from 'react-router'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import { useWebSocket } from '@/ws/useWebSocket'
import { useStore } from '@/store'
import { useThemeApplicator } from '@/hooks/useThemeApplicator'
import { useCharacterTheme } from '@/hooks/useCharacterTheme'
import { useAppInit } from '@/hooks/useAppInit'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import AuthGuard from '@/components/auth/AuthGuard'
import ViewportDrawer from '@/components/panels/ViewportDrawer'
import ModalContainer from '@/components/modals/ModalContainer'
import SpindleUIManager from '@/components/spindle/SpindleUIManager'
import ToastContainer from '@/components/shared/ToastContainer'
import useIsMobile from '@/hooks/useIsMobile'
import { useBadging } from '@/hooks/useBadging'
import styles from './App.module.css'

export default function App() {
  useWebSocket()
  useThemeApplicator()
  useCharacterTheme()
  useAppInit()
  useBadging()

  const isMobile = useIsMobile()
  const dockPanels = useStore((s) => s.dockPanels)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)

  const dockInsets = useMemo(() => {
    let left = 0, right = 0, top = 0, bottom = 0
    for (const p of dockPanels) {
      if (hiddenPlacements.includes(p.id)) continue
      const size = p.collapsed ? 36 : p.size
      // On mobile, left/right docks render as bottom sheets
      const edge = isMobile && (p.edge === 'left' || p.edge === 'right') ? 'bottom' : p.edge
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
  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated, loadSettings])

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
            </ErrorBoundary>
          </div>
        </MotionConfig>
      </LazyMotion>
    </AuthGuard>
  )
}
