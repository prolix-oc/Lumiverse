import { useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { ArrowUp, List, ListChecks, LoaderCircle, Pencil, UserRound } from 'lucide-react'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import { agentRunsApi } from '@/api/agent-runs'
import { generateApi } from '@/api/generate'
import { chatsApi, messagesApi } from '@/api/chats'
import { memoryCortexApi, type CortexIngestionStatus } from '@/api/memory-cortex'

import { loadoutsApi } from '@/api/loadouts'
import { recoverPooledGeneration, recoverAgentActivityRuns } from '@/lib/generation-recovery'
import { recoverAgentRuns } from '@/lib/agent-run-recovery'
import { charactersApi } from '@/api/characters'
import { packsApi } from '@/api/packs'
import { expressionsApi } from '@/api/expressions'
import { personaToastName } from '@/store/slices/personas'
import {
  CHAT_PERSONA_METADATA_KEY,
  resolveChatPersonaSelection,
  setPersistedChatPersonaId,
} from '@/lib/chatPersonaSelection'
import type { WallpaperRef } from '@/types/store'
import WallpaperLayer from '@/components/shared/WallpaperLayer'
import useSwipeKeyboard from '@/hooks/useSwipeKeyboard'
import useEditKeyboard from '@/hooks/useEditKeyboard'
import useIsMobile from '@/hooks/useIsMobile'
import { AgentRunLiveRegion, AgentRunProvisionalLocator } from './AgentRunActivity'
import { chatLoreDockMode, effectiveQuickToolbarDockRequest } from '@/lib/chatSurfaceLayout'
import { measureLayoutHeight } from '@/lib/uiScale'
import { resolveCouncilForChat } from '@/hooks/useCouncilProfiles'
import { CHAT_REVEAL_SETTLE_CAP_MS, getChatDisplaySettleDiagnostics } from '@/lib/chatDisplaySettle'
import MessageList from './MessageList'
import StreamingIndicator from './StreamingIndicator'
import MessageSelectBar from './MessageSelectBar'
import InputArea from './InputArea'
import ChatFindBar, { type ChatFindNavigationTarget } from './ChatFindBar'
import ScrollToBottom from './ScrollToBottom'
import MessageNavigator from './MessageNavigator'
import { registerChatDockerActionOwners } from './chatDockerActionCatalog'
import CouncilPill from './CouncilPill'
import PortraitPanel from './PortraitPanel'
import ExpressionDisplay from './expressions/ExpressionDisplay'
import FloatingAvatarViewer from './FloatingAvatarViewer'
import { QuickToolbar } from '../quick-toolbar/QuickToolbar'
import {
  isShowNativeBrowseMessages,
  isShowNativeScrollToTop,
  isShowNativeSelectMessages,
  readQuickToolbarPlacement,
} from '../quick-toolbar/quickToolbarDock'
import {
  OLDEST_MESSAGE_ACTION_ID,
  quickToolbarOwnsOldestMessage,
  quickToolbarRendersOldestMessageAction,
} from './chatNativeDockOwnership'
import { keepDockEnabledWhenFloating } from '@/lib/uiProductivityDefaults'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { SpindlePreGenerationActivityPayload } from '@/types/ws-events'
import styles from './ChatView.module.css'
import clsx from 'clsx'
import { markLandingPageChatReturn, peekLandingPageSnapshot } from '@/lib/landingPageSnapshot'
import { holdImagesForTransition } from '@/lib/imageDecodeCache'
import { takeChatNavigationSnapshot } from '@/lib/chatNavigationSnapshot'
import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'
import { resolveChatContentWidthPx } from '@/lib/chatContentWidth'

interface CortexNotice {
  variant: 'processing' | 'error'
  title: string
  detail: string
  percent?: number
}

interface SpindleNotice {
  variant: 'processing' | 'error'
  title: string
  detail: string
}

const SPINDLE_NOTICE_SHOW_DELAY_MS = 180
const SPINDLE_NOTICE_HIDE_DELAY_MS = 280
const SPINDLE_NOTICE_MIN_VISIBLE_MS = 700
const WALLPAPER_TRANSITION_HALF_MS = 260
const WALLPAPER_READY_FALLBACK_MS = 5000
const CHAT_CHROME_LEAVE_MS = 220

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function findExtensionChild(anchor: HTMLElement): Element | null {
  for (const child of anchor.children) {
    const marked = child.hasAttribute('data-spindle-extension-root') || child.hasAttribute('data-spindle-ext')
    // A retained extension root can contain the canonical host-surface wrapper
    // even when that surface intentionally renders no content. Inspect the
    // surface's contents, not the wrapper itself, otherwise delegated
    // chat_top_dock leaves an invisible host claiming the rail after reload.
    const surface = child.querySelector<HTMLElement>('[data-surface-id]')
    const contentRoot = surface ?? child
    const hasMountedContent = contentRoot.children.length > 0 || Boolean(contentRoot.textContent?.trim())
    if (marked && hasMountedContent) return child
  }
  return null
}

interface CortexRebuildStatus {
  chatId?: string
  status: string
  current?: number
  total?: number
  percent?: number
  error?: string
  source?: string
}

function formatChunkProgress(payload: CortexRebuildStatus, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const current = payload.current ?? 0
  const total = payload.total ?? 0
  return total > 0 ? t('chatView.cortexChunks', { current, total }) : ''
}

function formatIngestionDetail(status: CortexIngestionStatus, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const phaseDetail: Record<CortexIngestionStatus['phase'], string> = {
    queued: t('chatView.cortexQueued'),
    font: t('chatView.cortexFont'),
    heuristics: t('chatView.cortexHeuristics'),
    sidecar: t('chatView.cortexSidecar'),
    persisting: t('chatView.cortexPersisting'),
    complete: t('chatView.cortexComplete'),
    error: formatCortexError(status.error, t, 'chatView.cortexProcessingFailed'),
  }

  return phaseDetail[status.phase] + (status.pendingJobs > 1 ? t('chatView.cortexJobsPending', { count: status.pendingJobs }) : '')
}

function formatCortexError(
  error: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallbackKey: string,
): string {
  // Sidecar status codes are internal implementation details. They arrive via
  // the progress socket rather than a user-facing error contract, so never
  // render values such as "sidecar_failed" in the memory notice.
  if (/^sidecar(?:[_\s-].*)?$/i.test(error?.trim() ?? '')) {
    return t(fallbackKey)
  }
  return error || t(fallbackKey)
}

function formatRebuildDetail(payload: CortexRebuildStatus, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const action = payload.source === 'warmup'
    ? t('chatView.cortexPreparingMemory')
    : t('chatView.cortexRebuildingMemory')

  return action + formatChunkProgress(payload, t)
}

function buildCortexNotice(
  ingestionStatus: CortexIngestionStatus | null,
  rebuildStatus: CortexRebuildStatus | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): CortexNotice | null {
  if (rebuildStatus?.status === 'error') {
    return {
      variant: 'error',
      title: t('chatView.memory'),
      detail: formatCortexError(rebuildStatus.error, t, 'chatView.memoryRebuildFailed'),
      percent: rebuildStatus.percent,
    }
  }

  if (ingestionStatus?.status === 'error') {
    return {
      variant: 'error',
      title: t('chatView.memory'),
      detail: formatCortexError(ingestionStatus.error, t, 'chatView.backgroundMemoryFailed'),
    }
  }

  const rebuildProcessing = rebuildStatus?.status === 'processing'
  const ingestionProcessing = ingestionStatus?.status === 'processing'

  if (rebuildProcessing && ingestionProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: t('chatView.cortexCombined', { chunks: formatChunkProgress(rebuildStatus, t) }),
      percent: rebuildStatus.percent,
    }
  }

  if (rebuildProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: formatRebuildDetail(rebuildStatus, t),
      percent: rebuildStatus.percent,
    }
  }

  if (ingestionProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: formatIngestionDetail(ingestionStatus, t),
    }
  }

  return null
}

function normalizeRebuildStatus(payload: CortexRebuildStatus | null): CortexRebuildStatus | null {
  if (!payload) return null
  return payload.status === 'idle' || payload.status === 'complete' ? null : payload
}

function buildSpindleNotice(payload: SpindlePreGenerationActivityPayload, t: (key: string, opts?: Record<string, unknown>) => string): SpindleNotice {
  const phaseLabel: Record<SpindlePreGenerationActivityPayload['phase'], string> = {
    message_content_processor: t('chatView.spindleProcessingMessage'),
    context_handler: t('chatView.spindleProcessingContext'),
    interceptor: t('chatView.spindleProcessingInterceptor'),
  }

  if (payload.status === 'error') {
    return {
      variant: 'error',
      title: t('extension'),
      detail: payload.error || t('chatView.spindleFailed', { name: payload.extensionName, phase: phaseLabel[payload.phase] }),
    }
  }

  return {
    variant: 'processing',
    title: t('extension'),
    detail: t('chatView.spindleActive', { name: payload.extensionName, phase: phaseLabel[payload.phase] }),
  }
}

export default function ChatView() {
  const { t } = useTranslation('chat')
  const { chatId } = useParams<{ chatId: string }>()
  const navigate = useNavigate()
  const spindleActiveRef = useRef(new Map<string, SpindlePreGenerationActivityPayload>())
  const spindleLatestRef = useRef<SpindlePreGenerationActivityPayload | null>(null)
  const spindleShowTimerRef = useRef<number | null>(null)
  const spindleHideTimerRef = useRef<number | null>(null)
  const spindleVisibleAtRef = useRef<number | null>(null)
  const [ingestionStatus, setIngestionStatus] = useState<CortexIngestionStatus | null>(null)
  const [rebuildStatus, setRebuildStatus] = useState<CortexRebuildStatus | null>(null)
  const [spindleNotice, setSpindleNotice] = useState<SpindleNotice | null>(null)
  const [chatFindOpen, setChatFindOpen] = useState(false)
  const [chatFindFocusRequest, setChatFindFocusRequest] = useState(0)
  const [chatFindQuery, setChatFindQuery] = useState('')
  const [chatFindTarget, setChatFindTarget] = useState<ChatFindNavigationTarget | null>(null)
  const [messageNavigatorOpen, setMessageNavigatorOpen] = useState(false)
  const [loadingOldestMessage, setLoadingOldestMessage] = useState(false)
  const setActiveChat = useStore((s) => s.setActiveChat)
  const setMessages = useStore((s) => s.setMessages)
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeChatId = useStore((s) => s.activeChatId)
  const streamingError = useStore((s) => s.streamingError)
  const lastGenerationTerminalStatus = useStore((s) => s.lastGenerationTerminalStatus)
  const showTerminalGenerationStatus = !isStreaming && (
    Boolean(streamingError)
    || lastGenerationTerminalStatus === 'completed'
    || lastGenerationTerminalStatus === 'stopped'
    || lastGenerationTerminalStatus === 'error'
  )
  const messageEditDraft = useStore((s) => s.messageEditDraft)
  const resumeMessageEdit = useStore((s) => s.resumeMessageEdit)
  const totalChatLength = useStore((s) => s.totalChatLength)
  const portraitPanelOpen = useStore((s) => s.portraitPanelOpen)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const portraitPanelSide = useStore((s) => s.portraitPanelSide)
  const suiteExtensionEnabled = useStore((s) => hasEnabledFrontendExtension(s.extensions, 'lumiverse_suite'))
  const [portraitSurfaceOccupied, setPortraitSurfaceOccupied] = useState(false)
  const quickToolbarSettings = useStore((s) => s.quickToolbarSettings)
  const nativeDockActionSide = suiteExtensionEnabled && quickToolbarSettings?.nativeDockActionSide === 'left' ? 'left' : 'right'
  const quickToolbarPlacement = readQuickToolbarPlacement(quickToolbarSettings)
  // Native chat-top visibility follows the persisted flags in both Suite states.
  // Settings exposes these checkboxes with and without the Suite, so an absent
  // Suite no longer has to force them on to stay reachable.
  const showNativeSelectMessages = isShowNativeSelectMessages(quickToolbarSettings)
  const showNativeScrollToTop = isShowNativeScrollToTop(quickToolbarSettings)
  const showNativeBrowseMessages = isShowNativeBrowseMessages(quickToolbarSettings)
  const dockQuickToolbar = suiteExtensionEnabled && quickToolbarPlacement === 'chat_top_dock'
  const keepFloatingDockHost = suiteExtensionEnabled && quickToolbarPlacement === 'floating' && keepDockEnabledWhenFloating(quickToolbarSettings)
  // Starts optimistic so the settings-derived answer still holds for server
  // rendering and the first commit; the probe below corrects it from the DOM.
  const [quickToolbarRendersOldestAction, setQuickToolbarRendersOldestAction] = useState(true)
  const quickToolbarSettingsClaimOldestMessage = quickToolbarOwnsOldestMessage(
    suiteExtensionEnabled,
    quickToolbarSettings,
  )
  // Ownership must follow the action that is actually rendered. The persisted
  // setting alone hands the oldest-message action to a toolbar that may not be
  // mounted (floating host absent, hidden behind an overlay, replaced by an
  // extension) or that normalizes/packs the action out of its rendered list,
  // which left an eligible chat with no oldest-message control at all.
  const quickToolbarOwnsOldestMessageAction = quickToolbarSettingsClaimOldestMessage
    && quickToolbarRendersOldestAction
  // Native controls own the top strip. QuickToolbar placement is a separate
  // Suite concern and must not move or hide this native group.
  const nativeDockRequest = 'strip' as const
  const chatTopDockRequest = nativeDockRequest
  useEffect(() => {
    const readOccupied = () => {
      // The extension root can survive a ChatView transition while its new mount
      // anchor is being committed. Looking beneath only the first side anchor can
      // therefore miss the live owner and briefly restore the native dock. The
      // host-surface marker is unique to the extension-owned Portrait Dock, so it
      // is the ownership authority regardless of which current anchor contains it.
      setPortraitSurfaceOccupied(Boolean(
        document.querySelector('[data-spindle-host-surface="portrait_dock.workspace"]'),
      ))
      // Same authority rule for the shared oldest-message action: the rendered
      // control decides ownership, not the persisted toolbar setting. The
      // native copy is excluded by its own marker, so this cannot oscillate.
      setQuickToolbarRendersOldestAction(quickToolbarRendersOldestMessageAction(document))
    }
    readOccupied()
    const Observer = document.defaultView?.MutationObserver
    if (!Observer) return undefined
    const observer = new Observer(readOccupied)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const isMobile = useIsMobile()
  const portraitBackdropVisible = !portraitSurfaceOccupied && isMobile && portraitPanelOpen && portraitPanelSide !== 'none'
  const sceneBackground = useStore((s) => s.sceneBackground)
  const imageGeneration = useStore((s) => s.imageGeneration)
  const wallpaper = useStore((s) => s.wallpaper)
  const useCharacterBackground = useStore((s) => s.useCharacterBackground)
  const chatWidthMode = useStore((s) => s.chatWidthMode)
  const chatContentMaxWidth = useStore((s) => s.chatContentMaxWidth)
  const videoRef = useRef<HTMLVideoElement>(null)
  const chatColumnInnerRef = useRef<HTMLDivElement>(null)
  const chatColumnTopRef = useRef<HTMLDivElement>(null)
  const chatTopDockRef = useRef<HTMLDivElement>(null)
  const chatComposerAboveRef = useRef<HTMLSpanElement>(null)
  const wallpaperTransitionTimeouts = useRef<number[]>([])
  const chromeEnterTimerRef = useRef<number | null>(null)
  const chromeLeaveTimerRef = useRef<number | null>(null)
  // Stabilization is independent of animation preference: reduced-motion
  // users should still never see raw extension payloads before interceptors
  // attach. CSS makes the eventual reveal instantaneous for them.
  const [chatChromeEntering, setChatChromeEntering] = useState(true)
  const [chatChromeLeaving, setChatChromeLeaving] = useState(false)
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const setMessageSelectMode = useStore((s) => s.setMessageSelectMode)
  const activeModal = useStore((s) => s.activeModal)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  const toggleSelectMode = useCallback(() => {
    setMessageSelectMode(!messageSelectMode)
  }, [messageSelectMode, setMessageSelectMode])

  const closeChatFind = useCallback(() => {
    setChatFindOpen(false)
    setChatFindQuery('')
    setChatFindTarget(null)
  }, [])

  const openChatFind = useCallback(() => {
    setChatFindOpen(true)
    setChatFindFocusRequest((request) => request + 1)
  }, [])

  const clearChatFindTarget = useCallback(() => {
    setChatFindTarget(null)
  }, [])

  const navigateToOldestMessage = useCallback(async () => {
    if (!chatId || loadingOldestMessage) return
    setLoadingOldestMessage(true)
    try {
      const page = await messagesApi.list(chatId, { limit: 1, offset: 0 })
      const first = page.data[0]
      if (!first) return
      setChatFindTarget({
        id: first.id,
        index_in_chat: first.index_in_chat,
        offset: 0,
        messageTotal: page.total,
        requestId: Date.now(),
      })
    } catch {
      // Best-effort navigation: leave the current viewport untouched.
    } finally {
      setLoadingOldestMessage(false)
    }
  }, [chatId, loadingOldestMessage])

  const openMessageNavigator = useCallback(() => {
    setMessageNavigatorOpen(true)
  }, [])

  useEffect(() => registerChatDockerActionOwners({
    navigateToOldestMessage,
    navigateToOldestMessageLoading: loadingOldestMessage,
    openMessageNavigator,
  }), [loadingOldestMessage, navigateToOldestMessage, openMessageNavigator])

  const returnToEditedMessage = useCallback(() => {
    if (!chatId || !messageEditDraft || messageEditDraft.chatId !== chatId) return
    resumeMessageEdit()
    setChatFindTarget({
      id: messageEditDraft.messageId,
      index_in_chat: messageEditDraft.messageIndexInChat,
      offset: messageEditDraft.messageOffset,
      messageTotal: totalChatLength,
      requestId: Date.now(),
    })
  }, [chatId, messageEditDraft, resumeMessageEdit, totalChatLength])


  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (activeModal || commandPaletteOpen) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return

      event.preventDefault()
      openChatFind()
    }

    // Deliberately use the bubbling phase. ExpandedTextEditor owns its find
    // shortcut from a capture listener and stops propagation, so its local
    // Find remains authoritative when it is open above a chat.
    document.addEventListener('keydown', handleFindShortcut)
    return () => document.removeEventListener('keydown', handleFindShortcut)
  }, [activeModal, commandPaletteOpen, openChatFind])

  useEffect(() => {
    setChatFindOpen(false)
    setChatFindQuery('')
    setChatFindTarget(null)
    setMessageNavigatorOpen(false)
  }, [chatId])

  useSwipeKeyboard()
  useEditKeyboard()

  useLayoutEffect(() => {
    if (!chatId) return

    if (chromeEnterTimerRef.current !== null) {
      window.clearTimeout(chromeEnterTimerRef.current)
      chromeEnterTimerRef.current = null
    }

    setChatChromeEntering(true)
    document.body.setAttribute('data-chat-chrome-entering', 'true')
    const handlePopulated = (event: Event) => {
      const populatedChatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId
      if (populatedChatId !== chatId) return
      setChatChromeEntering(false)
      document.body.removeAttribute('data-chat-chrome-entering')
      if (chromeEnterTimerRef.current !== null) {
        window.clearTimeout(chromeEnterTimerRef.current)
        chromeEnterTimerRef.current = null
      }
    }
    window.addEventListener('lumiverse:chat-items-populated', handlePopulated)

    // Fallback if virtualizer fails or is completely empty. Must exceed the
    // MessageList settle gate (CHAT_REVEAL_SETTLE_CAP_MS) so a chat whose
    // content is still resolving does not get revealed mid-pipeline by this
    // timer racing the populated dispatch.
    chromeEnterTimerRef.current = window.setTimeout(() => {
      chromeEnterTimerRef.current = null
      const detail = {
        elapsedMs: CHAT_REVEAL_SETTLE_CAP_MS + 1500,
        ...getChatDisplaySettleDiagnostics(chatId),
      }
      console.warn('[ChatDisplaySettle] ChatView fallback reveal', detail)
      window.dispatchEvent(new CustomEvent('lumiverse:chat-display-fallback-timeout', { detail }))
      setChatChromeEntering(false)
      document.body.removeAttribute('data-chat-chrome-entering')
    }, CHAT_REVEAL_SETTLE_CAP_MS + 1500)

    return () => {
      window.removeEventListener('lumiverse:chat-items-populated', handlePopulated)
      if (chromeEnterTimerRef.current !== null) {
        window.clearTimeout(chromeEnterTimerRef.current)
        chromeEnterTimerRef.current = null
      }
      document.body.removeAttribute('data-chat-chrome-entering')
    }
  }, [chatId])

  useEffect(() => {
    return () => {
      if (chromeLeaveTimerRef.current !== null) {
        window.clearTimeout(chromeLeaveTimerRef.current)
        chromeLeaveTimerRef.current = null
      }
    }
  }, [])

  const completeNavigateHome = useCallback(() => {
    // Detach the visible chat before committing the route. In particular this
    // cancels the closure-owned 32ms stream flush; leaving it for passive
    // unmount cleanup gives that timer a window to write the streaming buffer
    // into the newly mounted landing page.
    const state = useStore.getState()
    if (state.activeChatId === chatId) {
      state.setActiveChat(null)
      state.clearGroupChat()
    }
    markLandingPageChatReturn()
    navigate('/')
  }, [chatId, navigate])

  const handleNavigateHome = useCallback(() => {
    if (chromeLeaveTimerRef.current !== null) return

    const landingImageUrls = peekLandingPageSnapshot()?.imageUrls ?? []
    if (landingImageUrls.length > 0) holdImagesForTransition(landingImageUrls)

    // Freeze the local stream on its newest frame before animating it out.
    // Standalone WebKit can terminate the page when the opacity/transform
    // transition and streaming subtree remeasurement run concurrently. The
    // backend generation and chat head continue normally during this pause.
    const state = useStore.getState()
    const isActivelyStreamingThisChat = state.activeChatId === chatId && state.isStreaming
    if (isActivelyStreamingThisChat) state.pauseStreamingForNavigation()

    if (prefersReducedMotion()) {
      completeNavigateHome()
      return
    }

    setChatChromeLeaving(true)
    chromeLeaveTimerRef.current = window.setTimeout(() => {
      chromeLeaveTimerRef.current = null
      completeNavigateHome()
    }, CHAT_CHROME_LEAVE_MS)
  }, [chatId, completeNavigateHome])

  const cortexNotice = useMemo(() => buildCortexNotice(ingestionStatus, rebuildStatus, t), [ingestionStatus, rebuildStatus, t])

  useEffect(() => {
    if (!spindleNotice || spindleNotice.variant !== 'error') return
    const timer = window.setTimeout(() => setSpindleNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [spindleNotice])

  useEffect(() => {
    if (!chatId) return
    let cancelled = false

    const clearSpindleShowTimer = () => {
      if (spindleShowTimerRef.current !== null) {
        window.clearTimeout(spindleShowTimerRef.current)
        spindleShowTimerRef.current = null
      }
    }

    const clearSpindleHideTimer = () => {
      if (spindleHideTimerRef.current !== null) {
        window.clearTimeout(spindleHideTimerRef.current)
        spindleHideTimerRef.current = null
      }
    }

    const getSpindleActivityKey = (payload: SpindlePreGenerationActivityPayload) => `${payload.phase}:${payload.extensionId}`

    const getLatestActivePayload = () => {
      const latest = spindleLatestRef.current
      if (latest && spindleActiveRef.current.has(getSpindleActivityKey(latest))) {
        return latest
      }
      const values = Array.from(spindleActiveRef.current.values())
      return values[values.length - 1] ?? null
    }

    const showSpindleNotice = (payload: SpindlePreGenerationActivityPayload) => {
      clearSpindleShowTimer()
      clearSpindleHideTimer()
      spindleVisibleAtRef.current = Date.now()
      setSpindleNotice(buildSpindleNotice(payload, t))
    }

    const scheduleSpindleHide = () => {
      clearSpindleShowTimer()
      clearSpindleHideTimer()
      const visibleAt = spindleVisibleAtRef.current
      const elapsed = visibleAt ? Date.now() - visibleAt : SPINDLE_NOTICE_MIN_VISIBLE_MS
      const delay = Math.max(SPINDLE_NOTICE_HIDE_DELAY_MS, SPINDLE_NOTICE_MIN_VISIBLE_MS - elapsed)
      spindleHideTimerRef.current = window.setTimeout(() => {
        spindleHideTimerRef.current = null
        spindleVisibleAtRef.current = null
        setSpindleNotice(null)
      }, delay)
    }

    const resetSpindleNotice = () => {
      spindleActiveRef.current.clear()
      spindleLatestRef.current = null
      clearSpindleShowTimer()
      clearSpindleHideTimer()
      spindleVisibleAtRef.current = null
      setSpindleNotice(null)
    }

    setIngestionStatus(null)
    setRebuildStatus(null)
    resetSpindleNotice()

    Promise.all([
      memoryCortexApi.getIngestionStatus(chatId).catch(() => null),
      memoryCortexApi.getRebuildStatus(chatId).catch(() => null),
    ]).then(([ingestion, rebuild]) => {
      if (cancelled) return
      setIngestionStatus(ingestion)
      setRebuildStatus(normalizeRebuildStatus(rebuild))
    })

    memoryCortexApi.warm(chatId).catch(() => {})

    const offIngestion = wsClient.on(EventType.CORTEX_INGESTION_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      setIngestionStatus(payload)
    })

    const offRebuild = wsClient.on(EventType.CORTEX_REBUILD_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      setRebuildStatus(normalizeRebuildStatus(payload))
    })

    const offSpindle = wsClient.on(EventType.SPINDLE_PRE_GENERATION_ACTIVITY, (payload: SpindlePreGenerationActivityPayload) => {
      if (!payload || payload.chatId !== chatId) return

      const key = getSpindleActivityKey(payload)

      if (payload.status === 'started') {
        spindleActiveRef.current.set(key, payload)
        spindleLatestRef.current = payload
        clearSpindleHideTimer()
        if (spindleVisibleAtRef.current !== null) {
          setSpindleNotice(buildSpindleNotice(payload, t))
        } else if (spindleShowTimerRef.current === null) {
          spindleShowTimerRef.current = window.setTimeout(() => {
            spindleShowTimerRef.current = null
            const activePayload = getLatestActivePayload()
            if (activePayload) showSpindleNotice(activePayload)
          }, SPINDLE_NOTICE_SHOW_DELAY_MS)
        }
        return
      }

      spindleActiveRef.current.delete(key)

      if (payload.status === 'error') {
        spindleLatestRef.current = null
        showSpindleNotice(payload)
        return
      }

      const nextPayload = getLatestActivePayload()
      spindleLatestRef.current = nextPayload
      if (nextPayload) {
        if (spindleVisibleAtRef.current !== null) {
          setSpindleNotice(buildSpindleNotice(nextPayload, t))
        }
        return
      }

      if (spindleVisibleAtRef.current !== null) {
        scheduleSpindleHide()
      } else {
        clearSpindleShowTimer()
      }
    })

    const offGenerationProgress = wsClient.on(EventType.GENERATION_IN_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      resetSpindleNotice()
    })

    const offGenerationEnd = wsClient.on(EventType.GENERATION_ENDED, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      resetSpindleNotice()
    })

    return () => {
      cancelled = true
      resetSpindleNotice()
      offIngestion()
      offRebuild()
      offSpindle()
      offGenerationProgress()
      offGenerationEnd()
    }
  }, [chatId, t])

  // Single source of truth for the chat content width. The resolver reports `null` for
  // every unconstrained mode, which is exactly the set of modes that must publish no
  // `--lumiverse-chat-content-width` variable at all.
  const innerStyle = useMemo<React.CSSProperties | undefined>(() => {
    const width = resolveChatContentWidthPx(chatWidthMode, chatContentMaxWidth)
    return width === null
      ? undefined
      : ({ '--lumiverse-chat-content-width': `${width}px` } as React.CSSProperties)
  }, [chatWidthMode, chatContentMaxWidth])

  // React Router reuses this component when only the chatId parameter changes.
  // Reset the previous chat in a layout effect so its messages and streaming
  // timer state cannot paint under the new route. Branch actions stage their
  // freshly loaded tail so that reset can hydrate the target in the same store
  // write instead of exposing an intermediate empty message list.
  useLayoutEffect(() => {
    if (!chatId || activeChatId === chatId) return

    const state = useStore.getState()
    const isHydratedMultiplayerPeer = !!state.mpRoomId
      && !state.mpIsHost
      && state.mpChatId === chatId
    if (isHydratedMultiplayerPeer) return

    const staged = takeChatNavigationSnapshot(chatId)
    const metadata = staged?.chat.metadata ?? null
    const wallpaper = metadata?.wallpaper as WallpaperRef | undefined
    setActiveChat(chatId, staged?.chat.character_id ?? null, staged ? {
      messages: staged.messagePage.data,
      total: staged.messagePage.total,
      displayOwner: staged.chat.character_display_owner ?? null,
      name: staged.chat.name ?? null,
      metadata,
      wallpaper: wallpaper?.image_id ? wallpaper : null,
    } : undefined)

    if (staged) {
      const next = useStore.getState()
      const groupCharacterIds: string[] = metadata?.group === true
        ? (metadata.character_ids || [])
        : []
      const mutedCharacterIds: string[] = metadata?.group === true
        ? (metadata.muted_character_ids || [])
        : []

      if (metadata?.group === true && groupCharacterIds.length > 0) {
        next.setGroupChat(true, groupCharacterIds, mutedCharacterIds)
      } else {
        next.clearGroupChat()
      }
    }
  }, [activeChatId, chatId, setActiveChat])

  // Load chat and messages
  useEffect(() => {
    if (!chatId) return

    let cancelled = false

    const loadChat = async () => {
      // Multiplayer peers don't own this chat — the host's instance can't be
      // fetched via the owner API. The join hydration + room WS events populate
      // the view instead, so skip the normal owner-scoped load.
      const mp = useStore.getState()
      if (mp.mpRoomId && !mp.mpIsHost && mp.mpChatId === chatId) return

      try {
        const pageSize = useStore.getState().messagesPerPage || 50

        // Fetch chat metadata and last messages in parallel
        const [chat, msgPage] = await Promise.all([
          chatsApi.get(chatId, { messages: false }),
          messagesApi.list(chatId, { limit: pageSize, tail: true }),
        ])
        if (cancelled) return

        const activeState = useStore.getState()
        if (activeState.activeChatId !== chatId) {
          setActiveChat(chatId, chat.character_id)
        } else {
          // The route-transition layout effect already performed the destructive
          // chat reset. Only fill in the owner now, so a generation event that
          // arrived during the fetch is not cleared a second time.
          activeState.setActiveCharacter(chat.character_id)
        }
        useStore.getState().setActiveChatDisplayOwner(chat.character_display_owner ?? null)
        useStore.getState().setActiveChatName(chat.name ?? null)
        setMessages(msgPage.data, msgPage.total)

        if (msgPage.data.length === 0) {
          requestAnimationFrame(() => {
            if (cancelled) return
            requestAnimationFrame(() => {
              if (cancelled) return
              window.dispatchEvent(new CustomEvent('lumiverse:chat-items-populated', { detail: { chatId } }))
            })
          })
        }

        // Chat-derived store state, applied synchronously with setMessages so
        // it lands in the same render batch. Each of these used to trickle in
        // after the network-dependent steps below, re-rendering every mounted
        // message card once per write.

        // Snapshot chat metadata into the store so features like TTS voice
        // resolution can read it without an extra fetch.
        useStore.getState().setActiveChatMetadata(chat.metadata ?? null)

        // Load per-chat wallpaper from metadata
        const wp = chat.metadata?.wallpaper as import('@/types/store').WallpaperRef | undefined
        if (wp?.image_id) {
          useStore.getState().setActiveChatWallpaper(wp)
        }

        // Detect group chat and initialize group state
        const isGroup = chat.metadata?.group === true
        const groupCharIds: string[] = isGroup ? (chat.metadata.character_ids || []) : []
        const mutedIds: string[] = isGroup ? (chat.metadata.muted_character_ids || []) : []

        if (isGroup && groupCharIds.length > 0) {
          useStore.getState().setGroupChat(true, groupCharIds, mutedIds)

          // Restore per-character group expressions
          const savedGroupExprs = chat.metadata?.group_expressions as Record<string, { label: string; imageId: string }> | undefined
          if (savedGroupExprs && Object.keys(savedGroupExprs).length > 0) {
            useStore.getState().setGroupExpressions(savedGroupExprs)
          } else {
            useStore.getState().clearGroupExpressions()
          }

          // Refresh group members on every chat open so avatars/profile data
          // don't get stuck on an older in-memory character snapshot.
          Promise.all(groupCharIds.map((id) => charactersApi.get(id).catch(() => null)))
            .then((chars) => {
              if (cancelled) return
              const valid = chars.filter(Boolean) as import('@/types/api').Character[]
              if (valid.length === 0) return

              const store = useStore.getState()
              for (const char of valid) {
                store.updateCharacter(char.id, char)
              }
            })
        } else {
          useStore.getState().clearGroupChat()
          useStore.getState().clearGroupExpressions()
        }

        // Restore active expression from chat metadata (async, fire-and-forget)
        const savedExpr = chat.metadata?.active_expression as string | undefined
        if (savedExpr && chat.character_id) {
          expressionsApi.get(chat.character_id).then((config) => {
            if (cancelled) return
            if (config?.enabled && config.mappings?.[savedExpr]) {
              useStore.getState().setActiveExpression(savedExpr, config.mappings[savedExpr], chat.character_id!)
            }
          }).catch(() => {})
        }

        // Start the character fetch now, in parallel with the generation
        // recovery below. Character-aware theming can't sample the avatar
        // until the character record is in the store, so every await ahead
        // of this fetch used to delay the chat's theme tint by one round trip.
        const cachedCharacter = chat.character_id
          ? useStore.getState().characters.find((c) => c.id === chat.character_id) ?? null
          : null
        const characterPromise: Promise<import('@/types/api').Character | null> = cachedCharacter
          ? Promise.resolve(cachedCharacter)
          : chat.character_id
            ? charactersApi.get(chat.character_id)
                .then((char) => {
                  if (!cancelled) useStore.getState().updateCharacter(char.id, char)
                  return char
                })
                .catch(() => null)
            : Promise.resolve(null)

        // If there's a pending council tools failure for this chat, show the retry modal now
        const pendingFailure = useStore.getState().councilToolsFailure
        if (pendingFailure && pendingFailure.chatId === chatId) {
          // Lazy import to avoid circular deps
          const { showCouncilRetryModal } = await import('@/hooks/useCouncilEvents')
          showCouncilRetryModal(pendingFailure)
        }

        // Recover any active or recently-completed generation. The helper is
        // also invoked on visibilitychange and WS reconnect so that any path
        // back to this chat re-syncs pooled tokens.
        if (!cancelled) await recoverPooledGeneration(chatId)
        // A terminal run may have no target message or the pool entry may have
        // expired before reload. Merge the authenticated status-only fallback.
        if (!cancelled) await recoverAgentActivityRuns(chatId)
        if (!cancelled) await recoverAgentRuns(chatId, agentRunsApi, useStore)

        // Opening a chat acknowledges any terminal chat-head state globally so
        // other devices stop showing a stale completed/stopped/error badge too.
        // Recover first so terminal impersonation drafts can still populate the input.
        const existingHead = useStore.getState().chatHeads.find((h) => h.chatId === chatId)
        if (existingHead && (existingHead.status === 'completed' || existingHead.status === 'stopped' || existingHead.status === 'error')) {
          useStore.getState().deleteChatHead(chatId)
        }
        generateApi.acknowledge(chatId).catch(() => {})

        const openedCharacter = await characterPromise

        // Resolve persona per chat: explicit chat selections win, then
        // character/tag auto-bindings, then the default persona. Temporary
        // chats are persona-less — leave the global persona alone.
        if (chat.metadata?.temporary !== true) {
          const {
            characterPersonaBindings,
            personaTagBindings,
            personas: allPersonas,
            setActivePersona,
            activePersonaId,
            setActiveChatMetadata,
          } = useStore.getState()
          const resolvedPersona = resolveChatPersonaSelection({
            metadata: chat.metadata,
            characterId: chat.character_id,
            characterTags: openedCharacter?.tags ?? [],
            personas: allPersonas,
            characterPersonaBindings,
            personaTagBindings,
          })
          const resolvedChatPersona = resolvedPersona.personaId
            ? allPersonas.find((p) => p.id === resolvedPersona.personaId) ?? null
            : null

          if (resolvedPersona.persistedPersonaStale) {
            const nextMetadata = setPersistedChatPersonaId(chat.metadata, null)
            chat.metadata = nextMetadata ?? {}
            if (!cancelled) {
              setActiveChatMetadata(nextMetadata)
            }
            chatsApi.patchMetadata(chatId, { [CHAT_PERSONA_METADATA_KEY]: null }).catch(() => {})
          }

          if (!cancelled && activePersonaId !== resolvedPersona.personaId) {
            setActivePersona(resolvedPersona.personaId)
            if (resolvedChatPersona && resolvedPersona.source !== 'default') {
              toast.info(t('chatView.switchedPersona', { name: personaToastName(resolvedChatPersona) }))
            }
          }

          if (
            (resolvedPersona.source === 'character' || resolvedPersona.source === 'tag') &&
            resolvedChatPersona &&
            resolvedPersona.addonStates &&
            Object.keys(resolvedPersona.addonStates).length > 0 &&
            !cancelled
          ) {
            // Apply the binding's add-on snapshot so the bound selections take
            // effect and are visible in this chat. Seed only when the chat has
            // no per-chat states for the persona yet, so a fresh chat picks up
            // the binding while later in-chat tweaks are never clobbered.
            if (
              resolvedPersona.addonStates &&
              Object.keys(resolvedPersona.addonStates).length > 0
            ) {
              const existing = (chat.metadata?.persona_addon_states ?? {}) as Record<string, Record<string, boolean>>
              if (!existing[resolvedChatPersona.id]) {
                const nextStates = { ...existing, [resolvedChatPersona.id]: { ...resolvedPersona.addonStates } }
                // Fold into chat.metadata and re-publish the snapshot (the
                // canonical publish already happened alongside setMessages);
                // persist for future opens.
                chat.metadata = { ...(chat.metadata ?? {}), persona_addon_states: nextStates }
                useStore.getState().setActiveChatMetadata(chat.metadata)
                chatsApi.patchMetadata(chatId, { persona_addon_states: nextStates }).catch(() => {})
              }
            }
          }
        }

        // Auto-apply loadout if a binding exists for this chat/character
        try {
          const resolved = await loadoutsApi.resolve(chatId)
          if (resolved.loadout && !cancelled) {
            const { applyLoadout } = useStore.getState()
            await applyLoadout(resolved.loadout.id)
            toast.info(t('chatView.appliedLoadout', { name: resolved.loadout.name }))
          }
        } catch { /* no loadout binding — that's fine */ }

        // Resolve council (members, tool toggles, sidecar) from the
        // council-profile system — its sole owner. Loadouts no longer carry
        // council, so the two can't override each other.
        try {
          const council = await resolveCouncilForChat(chatId, {
            characterId: chat.character_id,
            characterBindingEnabled: chat.metadata?.group !== true,
          })
          if (!cancelled) {
            const store = useStore.getState()
            store.setCouncilSettings(council.council_settings)
            store.setCouncilPersistenceTarget(council.target)

            const memberPackIds = new Set(
              council.council_settings.members.map((member) => member.packId).filter(Boolean),
            )
            for (const packId of memberPackIds) {
              if (!store.packsWithItems[packId]) {
                packsApi.get(packId)
                  .then((data) => useStore.getState().setPackWithItems(packId, data))
                  .catch(() => {})
              }
            }
          }
        } catch {
          // no council profile binding or resolution issue - keep current settings
        }

        // Refresh the active character on every chat open so profile/chat
        // surfaces don't rely on a stale cached avatar/image_id. The store
        // skips no-op updates, so the cached-snapshot case doesn't re-render
        // the message list. (Group member refresh happens above, alongside
        // the group state setup.)
        if (!isGroup && chat.character_id) {
          if (openedCharacter) {
            if (!cancelled) useStore.getState().updateCharacter(openedCharacter.id, openedCharacter)
          } else {
            charactersApi.get(chat.character_id).then((char) => {
              if (!cancelled) useStore.getState().updateCharacter(char.id, char)
            }).catch(() => {})
          }
        }
      } catch (err) {
        console.error('[ChatView] Failed to load chat:', err)
      }
    }

    loadChat()

    return () => {
      cancelled = true
    }
  }, [chatId, setActiveChat, setMessages, t])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const state = useStore.getState()
      // A home navigation now detaches synchronously. Avoid repeating that
      // reset (or letting a stale cleanup clear a newer active chat).
      if (state.activeChatId === chatId) {
        state.setActiveChat(null)
        state.clearGroupChat()
      }
    }
  }, [chatId])

  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)

  const characterBackground = useMemo((): WallpaperRef | null => {
    if (!useCharacterBackground || !activeCharacterId) return null
    const character = characters.find((c) => c.id === activeCharacterId)
    if (!character) return null

    const greetingIndex = (activeChatMetadata?.activeGreetingIndex as number) ?? 0
    const greetingBgs = character.extensions?.greeting_backgrounds as Record<number, string> | undefined
    const mappedImageId = greetingBgs?.[greetingIndex]

    const imageId = mappedImageId || character.image_id
    if (!imageId) return null
    return { image_id: imageId, type: 'image' }
  }, [useCharacterBackground, activeCharacterId, characters, activeChatMetadata])

  // Global wallpaper is persistent in App so video playback survives route
  // changes. ChatView only renders overrides above it.
  const effectiveWallpaper = activeChatWallpaper ?? (wallpaper.global ? null : characterBackground)
  const effectiveWallpaperKey = effectiveWallpaper ? `${effectiveWallpaper.type}:${effectiveWallpaper.image_id}` : 'none'
  const [displayedWallpaper, setDisplayedWallpaper] = useState<WallpaperRef | null>(effectiveWallpaper)
  const displayedWallpaperKeyRef = useRef(effectiveWallpaperKey)
  const pendingWallpaperReadyKeyRef = useRef<string | null>(null)
  const [wallpaperTransitioning, setWallpaperTransitioning] = useState(false)
  const hasAnyBackground = !!(sceneBackground || displayedWallpaper?.image_id || wallpaper.global?.image_id)
  const clearWallpaperTransitionTimers = useCallback(() => {
    wallpaperTransitionTimeouts.current.forEach(window.clearTimeout)
    wallpaperTransitionTimeouts.current = []
  }, [])

  useEffect(() => {
    clearWallpaperTransitionTimers()
    pendingWallpaperReadyKeyRef.current = null
    if (displayedWallpaperKeyRef.current === effectiveWallpaperKey) {
      setWallpaperTransitioning(false)
      return clearWallpaperTransitionTimers
    }

    setWallpaperTransitioning(true)

    const swapTimer = window.setTimeout(() => {
      displayedWallpaperKeyRef.current = effectiveWallpaperKey
      setDisplayedWallpaper(effectiveWallpaper)
      if (!effectiveWallpaper) {
        pendingWallpaperReadyKeyRef.current = null
        const revealTimer = window.setTimeout(() => setWallpaperTransitioning(false), 40)
        wallpaperTransitionTimeouts.current.push(revealTimer)
        return
      }

      pendingWallpaperReadyKeyRef.current = effectiveWallpaperKey
      const fallbackTimer = window.setTimeout(() => {
        if (pendingWallpaperReadyKeyRef.current !== effectiveWallpaperKey) return
        pendingWallpaperReadyKeyRef.current = null
        setWallpaperTransitioning(false)
      }, WALLPAPER_READY_FALLBACK_MS)
      wallpaperTransitionTimeouts.current.push(fallbackTimer)
    }, WALLPAPER_TRANSITION_HALF_MS)

    wallpaperTransitionTimeouts.current.push(swapTimer)
    return clearWallpaperTransitionTimers
  }, [clearWallpaperTransitionTimers, effectiveWallpaper, effectiveWallpaperKey])

  const handleWallpaperVisualReady = useCallback((wallpaperKey: string) => {
    if (pendingWallpaperReadyKeyRef.current !== wallpaperKey) return
    pendingWallpaperReadyKeyRef.current = null
    clearWallpaperTransitionTimers()
    const revealTimer = window.setTimeout(() => setWallpaperTransitioning(false), 40)
    wallpaperTransitionTimeouts.current.push(revealTimer)
  }, [clearWallpaperTransitionTimers])

  // Sync data-chat-bg on the root so message card CSS can skip backdrop-filter
  // when the background is a solid color (blur on solid = pure GPU waste).
  useEffect(() => {
    const root = document.documentElement
    if (hasAnyBackground) {
      root.setAttribute('data-chat-bg', '')
    } else {
      root.removeAttribute('data-chat-bg')
    }
    return () => root.removeAttribute('data-chat-bg')
  }, [hasAnyBackground])

  // Sync chat style opt-out attributes so message CSS can suppress effects.
  const bubbleDisableHover = useStore((s) => s.bubbleDisableHover)
  const bubbleHideAvatarBg = useStore((s) => s.bubbleHideAvatarBg)
  const bubbleOpacity = useStore((s) => s.bubbleOpacity ?? 1)
  useEffect(() => {
    const root = document.documentElement
    if (bubbleDisableHover) root.setAttribute('data-no-bubble-hover', '')
    else root.removeAttribute('data-no-bubble-hover')
    if (bubbleHideAvatarBg) root.setAttribute('data-no-bubble-avatar-bg', '')
    else root.removeAttribute('data-no-bubble-avatar-bg')
    // Drives the bubble card background fill alpha (see BubbleMessage.module.css).
    root.style.setProperty('--lcs-bubble-opacity', String(bubbleOpacity))
    return () => {
      root.removeAttribute('data-no-bubble-hover')
      root.removeAttribute('data-no-bubble-avatar-bg')
      root.style.removeProperty('--lcs-bubble-opacity')
    }
  }, [bubbleDisableHover, bubbleHideAvatarBg, bubbleOpacity])

  useLayoutEffect(() => {
    const chatColumnInner = chatColumnInnerRef.current
    const chatColumnTop = chatColumnTopRef.current
    const chatTopDock = chatTopDockRef.current
    if (!chatColumnInner || !chatColumnTop || !chatTopDock) return

    const syncComposerAnchor = () => {
      const composerAbove = chatColumnInner.querySelector<HTMLSpanElement>(
        '[data-spindle-mount="chat_composer_above"]',
      )
      chatComposerAboveRef.current = composerAbove
      return composerAbove
    }

    const syncOccupied = (anchor: HTMLElement) => {
      const occupied = findExtensionChild(anchor) !== null
      if (occupied) anchor.setAttribute('data-spindle-occupied', '')
      else anchor.removeAttribute('data-spindle-occupied')
    }

    const syncDockRequest = (anchor: HTMLElement, resolve: (request: unknown) => string, defaultRequest: string | null = null, resolveChild: (request: unknown) => string = resolve) => {
      const child = findExtensionChild(anchor)
      const requested = child?.getAttribute('data-dock-request') ?? defaultRequest
      const request = resolve(requested)
      const childRequest = child ? resolveChild(requested) : null
      if (anchor.getAttribute('data-dock-request') !== request) anchor.setAttribute('data-dock-request', request)
      if (child && childRequest !== null && child.getAttribute('data-dock-request') !== childRequest) child.setAttribute('data-dock-request', childRequest)
    }

    const syncTopDockHeight = () => {
      const height = measureLayoutHeight(chatTopDock)
      chatColumnInner.style.setProperty('--lcs-top-dock-height', `${height}px`)
    }

    const sync = () => {
      const composerAbove = syncComposerAnchor()
      syncOccupied(chatColumnTop)
      syncOccupied(chatTopDock)
      if (composerAbove) syncOccupied(composerAbove)
      syncDockRequest(chatColumnTop, (request) => effectiveQuickToolbarDockRequest(request, quickToolbarSettings))
      syncDockRequest(chatTopDock, () => nativeDockRequest, nativeDockRequest, (request) => effectiveQuickToolbarDockRequest(request, quickToolbarSettings))
      if (composerAbove) syncDockRequest(composerAbove, chatLoreDockMode)
      syncTopDockHeight()
    }

    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync)
    mutationObserver?.observe(chatColumnInner, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-dock-request'],
    })
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncTopDockHeight)
    resizeObserver?.observe(chatTopDock)
    window.addEventListener('resize', sync)
    window.visualViewport?.addEventListener('resize', sync)
    window.visualViewport?.addEventListener('scroll', sync)
    sync()

    return () => {
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', sync)
      window.visualViewport?.removeEventListener('resize', sync)
      window.visualViewport?.removeEventListener('scroll', sync)
      chatColumnTop.removeAttribute('data-spindle-occupied')
      chatTopDock.removeAttribute('data-spindle-occupied')
      chatComposerAboveRef.current?.removeAttribute('data-spindle-occupied')
      chatColumnTop.removeAttribute('data-dock-request')
      chatTopDock.removeAttribute('data-dock-request')
      chatComposerAboveRef.current?.removeAttribute('data-dock-request')
      chatColumnInner.style.removeProperty('--lcs-top-dock-height')
      chatComposerAboveRef.current = null
    }
  }, [chatId, dockQuickToolbar, keepFloatingDockHost, quickToolbarSettings])

  if (!chatId) return null

  return (
    <div
      data-component="ChatView"
      className={clsx(
        styles.container,
        isStreaming && styles.streaming,
        hasAnyBackground && styles.hasSceneBackground
      )}
      data-streaming={isStreaming || undefined}
    >
      <AgentRunLiveRegion chatId={chatId} />
      {/* Wallpaper layer (z-index 0) — lowest background, overridden by scene */}
      <WallpaperLayer
        wallpaper={displayedWallpaper}
        settings={wallpaper}
        hidden={!!sceneBackground}
        videoRef={videoRef}
        fadeInOnMount
        onVisualReady={handleWallpaperVisualReady}
      />

      {/* Scene background layer — overrides wallpaper when active */}
      <div
        className={styles.sceneBackgroundLayer}
        style={{
          backgroundImage: sceneBackground ? `url("${sceneBackground}")` : 'none',
          opacity: sceneBackground ? Math.max(0, Math.min(1, imageGeneration.backgroundOpacity ?? 0.35)) : 0,
          transitionDuration: `${Math.max(100, imageGeneration.fadeTransitionMs ?? 800)}ms`,
        }}
      />
      <div
        className={styles.sceneTextContextLayer}
        style={{
          opacity: hasAnyBackground ? 1 : 0,
          transitionDuration: `${Math.max(100, imageGeneration.fadeTransitionMs ?? 800)}ms`,
        }}
      />
      <div className={clsx(styles.wallpaperTransitionLayer, wallpaperTransitioning && !sceneBackground && styles.wallpaperTransitionLayerActive)} />
      <div className={styles.body} data-lumiverse-surface="chat-body" data-chat-width-mode={chatWidthMode} {...(chatWidthMode !== 'full' ? { 'data-chat-constrained': '' } : {})}>
        <div data-spindle-mount="chat_sidebar_left" data-spindle-scope={`chat:${chatId}:sidebar-left`} style={{ display: 'contents' }} />
        {!portraitSurfaceOccupied && portraitPanelSide !== 'none' && portraitPanelSide === 'left' && (
          <div className={clsx(styles.portraitSide, styles.portraitSideLeft, portraitPanelOpen && styles.portraitSideOpen)}>
            {!isMobile && !portraitSurfaceOccupied && <PortraitPanel side="left" />}
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabLeft, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label={t('chatView.togglePortraitPanel')}
            >
              <UserRound size={14} />
            </button>
          </div>
        )}

        <div className={styles.chatColumn} data-lumiverse-surface="chat-column">
          <AgentRunProvisionalLocator chatId={chatId} />
          {(spindleNotice || cortexNotice) && (
            <div className={styles.noticeDock} aria-live="polite" aria-atomic="true">
              {spindleNotice && (
                <div className={clsx(styles.cortexNotice, styles.spindleNotice, spindleNotice.variant === 'error' && styles.cortexNoticeError)}>
                  <span className={styles.cortexNoticeStatus} aria-hidden="true" />
                  <span className={styles.cortexNoticeTitle}>{spindleNotice.title}</span>
                  <span className={styles.cortexNoticeSeparator} aria-hidden="true">•</span>
                  <span className={styles.cortexNoticeDetail}>{spindleNotice.detail}</span>
                  <span className={styles.cortexNoticePercent} />
                  <span className={clsx(styles.cortexNoticeBar, styles.spindleNoticeBar)} aria-hidden="true">
                    <span className={styles.spindleNoticeFill} />
                  </span>
                </div>
              )}
              {cortexNotice && (
                <div className={clsx(styles.cortexNotice, cortexNotice.variant === 'error' && styles.cortexNoticeError)}>
                  <span className={styles.cortexNoticeStatus} aria-hidden="true" />
                  <span className={styles.cortexNoticeTitle}>{cortexNotice.title}</span>
                  <span className={styles.cortexNoticeSeparator} aria-hidden="true">•</span>
                  <span className={styles.cortexNoticeDetail}>{cortexNotice.detail}</span>
                  <span className={styles.cortexNoticePercent}>{typeof cortexNotice.percent === 'number' ? `${cortexNotice.percent}%` : ''}</span>
                  {typeof cortexNotice.percent === 'number' && (
                    <span className={styles.cortexNoticeBar} aria-hidden="true">
                      <span className={styles.cortexNoticeFill} style={{ transform: `scaleX(${Math.max(0, Math.min(1, cortexNotice.percent / 100))})` }} />
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <div
            ref={chatColumnInnerRef}
            className={styles.chatColumnInner}
            data-lumiverse-surface="chat-column-inner"
            style={innerStyle}
            data-select-mode={messageSelectMode || undefined}
            data-chat-chrome-entering={chatChromeEntering || undefined}
            data-chat-chrome-leaving={(wallpaperTransitioning || chatChromeLeaving) || undefined}
          >
            <div ref={chatColumnTopRef} data-spindle-mount="chat_column_top" />
            <div data-spindle-mount="chat_header_left" data-spindle-scope={`chat:${chatId}:header-left`} style={{ display: 'contents' }} />
            <div data-spindle-mount="chat_header_center" data-spindle-scope={`chat:${chatId}:header-center`} style={{ display: 'contents' }} />
            <div data-spindle-mount="chat_header_right" data-spindle-scope={`chat:${chatId}:header-right`} style={{ display: 'contents' }} />
            <div ref={chatTopDockRef} className={styles.chatToolbar} data-spindle-mount="chat_top_dock" data-spindle-scope={`chat:${chatId}:top-dock`} data-dock-request={chatTopDockRequest} data-native-action-side={nativeDockActionSide}>
              <div className={styles.nativeDockActions}>
                {showNativeSelectMessages && (
                  <button type="button" className={clsx(styles.toolbarBtn, messageSelectMode && styles.toolbarBtnActive)} onClick={toggleSelectMode} title={messageSelectMode ? t('chatView.exitSelectionMode') : t('chatView.selectMessages')} aria-label={messageSelectMode ? t('chatView.exitSelectionMode') : t('chatView.selectMessages')} aria-pressed={messageSelectMode}>
                    <ListChecks size={14} />
                  </button>
                )}
                {!quickToolbarOwnsOldestMessageAction && showNativeScrollToTop && totalChatLength > 1 && (
                  <button type="button" className={styles.toolbarBtn} data-toolbar-action={OLDEST_MESSAGE_ACTION_ID} data-native-dock-action={OLDEST_MESSAGE_ACTION_ID} onClick={() => void navigateToOldestMessage()} disabled={loadingOldestMessage} title={t('scrollToTop')} aria-label={t('scrollToTop')}>
                    {loadingOldestMessage ? <LoaderCircle size={14} className={styles.toolbarSpinner} /> : <ArrowUp size={14} />}
                  </button>
                )}
                {showNativeBrowseMessages && totalChatLength > 0 && (
                  <button type="button" className={styles.toolbarBtn} onClick={openMessageNavigator} title={t('messageNavigator.open')} aria-label={t('messageNavigator.open')}>
                    <List size={14} />
                  </button>
                )}
                {messageEditDraft?.chatId === chatId && (
                  <button type="button" className={clsx(styles.toolbarBtn, styles.toolbarBtnActive)} onClick={returnToEditedMessage} title={t('messageNavigator.returnToEdit')} aria-label={t('messageNavigator.returnToEdit')}>
                    <Pencil size={14} />
                  </button>
                )}
              </div>
              {dockQuickToolbar && <QuickToolbar />}
            </div>
            <ChatFindBar
              chatId={chatId}
              open={chatFindOpen}
              focusRequest={chatFindFocusRequest}
              onClose={closeChatFind}
              onNavigate={setChatFindTarget}
              onClearTarget={clearChatFindTarget}
              onQueryChange={setChatFindQuery}
            />
            <MessageNavigator
              chatId={chatId}
              open={messageNavigatorOpen}
              onClose={() => setMessageNavigatorOpen(false)}
              onNavigate={setChatFindTarget}
            />
            <MessageList
              messages={messages}
              chatId={chatId}
              isStreaming={isStreaming}
              findTarget={chatFindTarget}
              findQuery={chatFindQuery}
            />
            <ScrollToBottom />
            <CouncilPill />
            {messageSelectMode && <MessageSelectBar chatId={chatId} />}
            <div data-spindle-mount="chat_bottom_dock" data-spindle-scope={`chat:${chatId}:bottom-dock`} data-dock-request="strip" />
            {isStreaming || showTerminalGenerationStatus ? <StreamingIndicator /> : null}
            <InputArea chatId={chatId} onNavigateHome={handleNavigateHome} onOpenChatFind={openChatFind} />
          </div>
        </div>

        {!portraitSurfaceOccupied && portraitPanelSide !== 'none' && portraitPanelSide === 'right' && (
          <div className={clsx(styles.portraitSide, styles.portraitSideRight, portraitPanelOpen && styles.portraitSideOpen)}>
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabRight, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label={t('chatView.togglePortraitPanel')}
            >
              <UserRound size={14} />
            </button>
            {!isMobile && !portraitSurfaceOccupied && <PortraitPanel side="right" />}
          </div>
        )}
        <div data-spindle-mount="chat_sidebar_right" data-spindle-scope={`chat:${chatId}:sidebar-right`} style={{ display: 'contents' }} />
        <div data-spindle-mount="lorebook_half_workspace" data-spindle-scope={`chat:${chatId}:lorebook-half-workspace`} />
        <div data-spindle-mount="chat_surface_side" data-spindle-scope={`chat:${chatId}:surface-side`} />
      </div>
      {isMobile && !portraitSurfaceOccupied && portraitPanelSide !== 'none' && (
        <PortraitPanel
          side={portraitPanelSide}
          mobileDrawer
          open={portraitPanelOpen}
        />
      )}
      {portraitBackdropVisible && (
        <div
          className={styles.portraitBackdrop}
          onClick={togglePortraitPanel}
          aria-hidden="true"
        />
      )}
      <ExpressionDisplay />
      <FloatingAvatarViewer />
    </div>
  )
}
