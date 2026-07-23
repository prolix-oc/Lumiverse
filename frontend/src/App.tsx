import { useEffect, useMemo, useRef } from 'react'
import { Outlet } from 'react-router'
import { listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import { useWebSocket } from '@/ws/useWebSocket'
import { useStore } from '@/store'
import { useThemeApplicator } from '@/hooks/useThemeApplicator'
import { useCharacterTheme } from '@/hooks/useCharacterTheme'
import { useCustomCSSApplicator } from '@/hooks/useCustomCSSApplicator'
import { useAppInit } from '@/hooks/useAppInit'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import AuthGuard from '@/components/auth/AuthGuard'
import ViewportDrawer from '@/components/panels/ViewportDrawer'
import CharacterEditorPage from '@/components/panels/character-browser/CharacterEditorPage'
import ModalContainer from '@/components/modals/ModalContainer'
import SpindleUIManager from '@/components/spindle/SpindleUIManager'
import ToastContainer from '@/components/shared/ToastContainer'
import ConnectionLostOverlay from '@/components/shared/ConnectionLostOverlay'
import ChatHeads from '@/components/chat-heads/ChatHeads'
import WallpaperLayer from '@/components/shared/WallpaperLayer'
import useIsMobile from '@/hooks/useIsMobile'
import { useBadging } from '@/hooks/useBadging'
import { useTTSAutoPlay } from '@/hooks/useTTSAutoPlay'
import { useAutoSummarization } from '@/hooks/useAutoSummarization'
import { usePresetRegexActivation } from '@/hooks/usePresetRegexActivation'
import { useBoundPresetSelection } from '@/hooks/useBoundPresetSelection'
import { RouterContextExporter } from '@/lib/router-bridge'
import { resolveDockPanelEdge } from '@/lib/spindle/dock-placement'
import { installNotificationAudioPrimer } from '@/lib/notificationAudio'
import { getSafeThemeState } from '@/lib/safeThemeMode'
import DesktopFloatingWidgetHost from '@/components/spindle/DesktopFloatingWidgetHost'
import {
  buildDesktopFloatingWidgetCatalog,
  type DesktopFloatingWidgetCatalogEntry,
  type DesktopFloatingWidgetPopoutState,
  isDesktopFloatingWidgetWindow,
  publishDesktopFloatingWidgetCatalog,
  resizeDesktopFloatingWidget,
} from '@/lib/desktop-floating-widget'
import styles from './App.module.css'

export default function App() {
  const { t } = useTranslation('common')
  const safeTheme = getSafeThemeState()
  useWebSocket()
  useThemeApplicator()
  useCharacterTheme()
  useCustomCSSApplicator()
  useAppInit()
  useDocumentTitle()
  useBadging()
  useTTSAutoPlay()
  useAutoSummarization()
  useBoundPresetSelection()
  usePresetRegexActivation()

  useEffect(() => installNotificationAudioPrimer(), [])

  const isMobile = useIsMobile()
  const dockPanels = useStore((s) => s.dockPanels)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const dockPanelDesktopSide = useStore((s) => s.spindleSettings.dockPanelDesktopSide)
  const wallpaper = useStore((s) => s.wallpaper)
  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)
  const sceneBackground = useStore((s) => s.sceneBackground)
  const globalWallpaperHidden = !!activeChatWallpaper?.image_id || !!sceneBackground
  const editingCharacterId = useStore((s) => s.editingCharacterId)
  const floatWidgets = useStore((s) => s.floatWidgets)
  const extensions = useStore((s) => s.extensions)
  const lastDesktopCatalog = useRef<string | null>(null)

  // Native child windows send their resized bounds back here. Keeping the
  // primary placement registry current means a later extension setSize call
  // grows from the user's actual widget size instead of the launch default.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window) || isDesktopFloatingWidgetWindow()) return
    let unlisten: (() => void) | undefined
    void listen<DesktopFloatingWidgetCatalogEntry>('desktop-widget-size', ({ payload }) => {
      useStore.getState().updateFloatWidget(payload.id, {
        width: payload.width,
        height: payload.height,
      })
    }).then((stop) => { unlisten = stop })
    return () => { unlisten?.() }
  }, [])

  // The native tray owns opening and returning pop-outs. Its lifecycle event
  // determines whether this page renders the extension widget's root.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window) || isDesktopFloatingWidgetWindow()) return
    let unlisten: (() => void) | undefined
    void listen<DesktopFloatingWidgetPopoutState>('desktop-widget-popout-state', ({ payload }) => {
      if (!payload || typeof payload.id !== 'string' || typeof payload.poppedOut !== 'boolean') return
      const widget = useStore.getState().floatWidgets.find((entry) => entry.id === payload.id)
      useStore.getState().updateFloatWidget(payload.id, { desktopPoppedOut: payload.poppedOut })
      if (!payload.poppedOut && widget) {
        // The page extension remains loaded while its widget root is handed to
        // a native WebView. Tell it that the root has returned so extensions
        // with live backend state can explicitly refresh their page instance.
        window.dispatchEvent(new CustomEvent('spindle:desktop-widget-returned', {
          detail: { widgetId: widget.id, extensionId: widget.extensionId },
        }))
      }
    }).then((stop) => { unlisten = stop })
    return () => { unlisten?.() }
  }, [])

  // FloatWidgetHandle.setSize emits this internal frontend event. A desktop
  // child window can resize immediately instead of waiting for the normal
  // catalog synchronization effect below.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window) || isDesktopFloatingWidgetWindow()) return
    const handleSizeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ widgetId?: unknown; width?: unknown; height?: unknown }>).detail
      if (
        !detail ||
        typeof detail.widgetId !== 'string' ||
        typeof detail.width !== 'number' ||
        typeof detail.height !== 'number' ||
        !Number.isInteger(detail.width) ||
        !Number.isInteger(detail.height)
      ) return
      console.info('[desktop-widget] primary frontend received size request', detail)
      void resizeDesktopFloatingWidget(detail.widgetId, detail.width, detail.height)
        .then(() => console.info('[desktop-widget] primary frontend forwarded size request', detail))
        .catch((error) => console.warn('[desktop-widget] primary frontend failed to forward size request', detail, error))
    }
    window.addEventListener('spindle:float-size-request', handleSizeRequest)
    return () => window.removeEventListener('spindle:float-size-request', handleSizeRequest)
  }, [])

  useEffect(() => {
    if (isDesktopFloatingWidgetWindow()) return
    const catalog = buildDesktopFloatingWidgetCatalog(floatWidgets, extensions)
    const serialized = JSON.stringify(catalog)
    if (serialized === lastDesktopCatalog.current) return
    lastDesktopCatalog.current = serialized
    void publishDesktopFloatingWidgetCatalog(catalog).catch(() => {
      // Browser/PWA clients deliberately do not have the desktop command.
    })
  }, [floatWidgets, extensions])

  const dockInsets = useMemo(() => {
    let left = 0, right = 0, top = 0, bottom = 0
    for (const p of dockPanels) {
      if (hiddenPlacements.includes(p.id)) continue
      const size = p.collapsed ? 36 : p.size
      const edge = resolveDockPanelEdge(p.edge, dockPanelDesktopSide, isMobile)
      switch (edge) {
        case 'left': left = Math.max(left, size); break
        case 'right': right = Math.max(right, size); break
        case 'top': top = Math.max(top, size); break
        case 'bottom': bottom = Math.max(bottom, size); break
      }
    }
    return { left, right, top, bottom }
  }, [dockPanels, hiddenPlacements, isMobile, dockPanelDesktopSide])

  const openDrawer = useStore((s) => s.openDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const setActiveProfile = useStore((s) => s.setActiveProfile)
  const setActiveImageGenConnection = useStore((s) => s.setActiveImageGenConnection)

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

  const content = isDesktopFloatingWidgetWindow() ? <DesktopFloatingWidgetHost /> : (
    <>
      <LazyMotion features={domAnimation} strict={false}>
        <MotionConfig reducedMotion="user">
          <div
            className={styles.app}
            data-app-root=""
            style={{
              '--spindle-dock-left': `${dockInsets.left}px`,
              '--spindle-dock-right': `${dockInsets.right}px`,
              '--spindle-dock-top': `${dockInsets.top}px`,
              '--spindle-dock-bottom': `${dockInsets.bottom}px`,
            } as React.CSSProperties}
          >
              {safeTheme.active && (
                <div className={styles.safeThemeBanner} role="status">
                  {t(`safeTheme.${safeTheme.source ?? 'url'}`)}
                </div>
              )}
              <WallpaperLayer wallpaper={wallpaper.global} settings={wallpaper} hidden={globalWallpaperHidden} fixed fadeInOnMount />
              <ErrorBoundary label="App">
                {/* Mirrors react-router context out to detached drawer-tab roots */}
                <RouterContextExporter />
                <main className={styles.main}>
                  <Outlet />
                </main>
                <ViewportDrawer />
                {editingCharacterId && <CharacterEditorPage />}
                <ModalContainer />
                <SpindleUIManager />
                <ToastContainer />
                <ChatHeads />
                <ConnectionLostOverlay />
              </ErrorBoundary>
          </div>
        </MotionConfig>
      </LazyMotion>
    </>
  )

  return (
    <AuthGuard>
      {content}
    </AuthGuard>
  )
}
