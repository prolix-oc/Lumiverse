import { useEffect, useMemo, useRef, useCallback, useState } from 'react'
import { useParams } from 'react-router'
import { UserRound, ListChecks } from 'lucide-react'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import { chatsApi, messagesApi } from '@/api/chats'
import { memoryCortexApi, type CortexIngestionStatus } from '@/api/memory-cortex'
import { generateApi } from '@/api/generate'
import { loadoutsApi } from '@/api/loadouts'
import { councilApi } from '@/api/council'
import { recoverPooledGeneration } from '@/lib/generation-recovery'
import { charactersApi } from '@/api/characters'
import { packsApi } from '@/api/packs'
import { imagesApi } from '@/api/images'
import { expressionsApi } from '@/api/expressions'
import { resolveAutoPersonaBinding } from '@/store/slices/personas'
import type { WallpaperRef } from '@/types/store'
import useSwipeKeyboard from '@/hooks/useSwipeKeyboard'
import useEditKeyboard from '@/hooks/useEditKeyboard'
import { councilSourceToTarget } from '@/hooks/useCouncilProfiles'
import MessageList from './MessageList'
import MessageSelectBar from './MessageSelectBar'
import InputArea from './InputArea'
import ScrollToBottom from './ScrollToBottom'
import CouncilPill from './CouncilPill'
import PortraitPanel from './PortraitPanel'
import ExpressionDisplay from './expressions/ExpressionDisplay'
import FloatingAvatarViewer from './FloatingAvatarViewer'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { SpindlePreGenerationActivityPayload } from '@/types/ws-events'
import styles from './ChatView.module.css'
import clsx from 'clsx'

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

interface CortexRebuildStatus {
  chatId?: string
  status: string
  current?: number
  total?: number
  percent?: number
  error?: string
  source?: string
}

function formatIngestionDetail(status: CortexIngestionStatus): string {
  const phaseDetail: Record<CortexIngestionStatus['phase'], string> = {
    queued: 'Queued for processing',
    font: 'Extracting font and style cues',
    heuristics: 'Scoring salience and relationships',
    sidecar: 'Running sidecar analysis',
    persisting: 'Saving memory updates',
    complete: 'Complete',
    error: status.error || 'Processing failed',
  }

  return phaseDetail[status.phase] + (status.pendingJobs > 1 ? `, ${status.pendingJobs} jobs pending` : '')
}

function formatChunkProgress(payload: CortexRebuildStatus): string {
  const current = payload.current ?? 0
  const total = payload.total ?? 0
  return total > 0 ? `, ${current}/${total} chunks` : ''
}

function formatRebuildDetail(payload: CortexRebuildStatus): string {
  const action = payload.source === 'warmup'
    ? 'Preparing Long-Term Chat Memory'
    : 'Rebuilding Long-Term Chat Memory'

  return action + formatChunkProgress(payload)
}

function buildCortexNotice(ingestionStatus: CortexIngestionStatus | null, rebuildStatus: CortexRebuildStatus | null): CortexNotice | null {
  if (rebuildStatus?.status === 'error') {
    return {
      variant: 'error',
      title: 'Memory',
      detail: rebuildStatus.error || 'Chat memory rebuild failed.',
      percent: rebuildStatus.percent,
    }
  }

  if (ingestionStatus?.status === 'error') {
    return {
      variant: 'error',
      title: 'Memory',
      detail: ingestionStatus.error || 'Background memory processing failed.',
    }
  }

  const rebuildProcessing = rebuildStatus?.status === 'processing'
  const ingestionProcessing = ingestionStatus?.status === 'processing'

  if (rebuildProcessing && ingestionProcessing) {
    return {
      variant: 'processing',
      title: 'Memory',
      detail: `Preparing Long-Term Chat Memory + Cortex${formatChunkProgress(rebuildStatus)}`,
      percent: rebuildStatus.percent,
    }
  }

  if (rebuildProcessing) {
    return {
      variant: 'processing',
      title: 'Memory',
      detail: formatRebuildDetail(rebuildStatus),
      percent: rebuildStatus.percent,
    }
  }

  if (ingestionProcessing) {
    return {
      variant: 'processing',
      title: 'Memory',
      detail: formatIngestionDetail(ingestionStatus),
    }
  }

  return null
}

function normalizeRebuildStatus(payload: CortexRebuildStatus | null): CortexRebuildStatus | null {
  if (!payload) return null
  return payload.status === 'idle' || payload.status === 'complete' ? null : payload
}

function buildSpindleNotice(payload: SpindlePreGenerationActivityPayload): SpindleNotice {
  const phaseLabel: Record<SpindlePreGenerationActivityPayload['phase'], string> = {
    message_content_processor: 'processing your message',
    context_handler: 'preparing generation context',
    interceptor: 'running a prompt interceptor',
  }

  if (payload.status === 'error') {
    return {
      variant: 'error',
      title: 'Extension',
      detail: payload.error || `${payload.extensionName} failed while ${phaseLabel[payload.phase]}.`,
    }
  }

  return {
    variant: 'processing',
    title: 'Extension',
    detail: `${payload.extensionName} is ${phaseLabel[payload.phase]}`,
  }
}

export default function ChatView() {
  const { chatId } = useParams<{ chatId: string }>()
  const autoSwitchedPersonaIdRef = useRef<string | null>(null)
  const [ingestionStatus, setIngestionStatus] = useState<CortexIngestionStatus | null>(null)
  const [rebuildStatus, setRebuildStatus] = useState<CortexRebuildStatus | null>(null)
  const [spindleNotice, setSpindleNotice] = useState<SpindleNotice | null>(null)
  const setActiveChat = useStore((s) => s.setActiveChat)
  const setMessages = useStore((s) => s.setMessages)
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeChatId = useStore((s) => s.activeChatId)
  const portraitPanelOpen = useStore((s) => s.portraitPanelOpen)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const portraitPanelSide = useStore((s) => s.portraitPanelSide)
  const sceneBackground = useStore((s) => s.sceneBackground)
  const imageGeneration = useStore((s) => s.imageGeneration)
  const wallpaper = useStore((s) => s.wallpaper)
  const chatWidthMode = useStore((s) => s.chatWidthMode)
  const chatContentMaxWidth = useStore((s) => s.chatContentMaxWidth)
  const videoRef = useRef<HTMLVideoElement>(null)
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const setMessageSelectMode = useStore((s) => s.setMessageSelectMode)
  const toggleSelectMode = useCallback(() => {
    setMessageSelectMode(!messageSelectMode)
  }, [messageSelectMode, setMessageSelectMode])

  useSwipeKeyboard()
  useEditKeyboard()

  const cortexNotice = useMemo(() => buildCortexNotice(ingestionStatus, rebuildStatus), [ingestionStatus, rebuildStatus])

  useEffect(() => {
    if (!spindleNotice || spindleNotice.variant !== 'error') return
    const timer = window.setTimeout(() => setSpindleNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [spindleNotice])

  useEffect(() => {
    if (!chatId) return
    let cancelled = false
    setIngestionStatus(null)
    setRebuildStatus(null)

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
      if (payload.status === 'started' || payload.status === 'error') {
        setSpindleNotice(buildSpindleNotice(payload))
        return
      }
      setSpindleNotice(null)
    })

    const offGenerationProgress = wsClient.on(EventType.GENERATION_IN_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      setSpindleNotice(null)
    })

    const offGenerationEnd = wsClient.on(EventType.GENERATION_ENDED, (payload: any) => {
      if (!payload || payload.chatId !== chatId) return
      setSpindleNotice(null)
    })

    return () => {
      cancelled = true
      offIngestion()
      offRebuild()
      offSpindle()
      offGenerationProgress()
      offGenerationEnd()
    }
  }, [chatId])

  const innerStyle = useMemo(() => {
    switch (chatWidthMode) {
      case 'comfortable': return { '--lumiverse-chat-content-width': '1000px' } as React.CSSProperties
      case 'compact': return { '--lumiverse-chat-content-width': '760px' } as React.CSSProperties
      case 'custom': return { '--lumiverse-chat-content-width': `${chatContentMaxWidth}px` } as React.CSSProperties
      default: return undefined
    }
  }, [chatWidthMode, chatContentMaxWidth])

  // Load chat and messages
  useEffect(() => {
    if (!chatId) return

    let cancelled = false

    const loadChat = async () => {
      try {
        const pageSize = useStore.getState().messagesPerPage || 50

        // Fetch chat metadata and last messages in parallel
        const [chat, msgPage] = await Promise.all([
          chatsApi.get(chatId, { messages: false }),
          messagesApi.list(chatId, { limit: pageSize, tail: true }),
        ])
        if (cancelled) return

        setActiveChat(chatId, chat.character_id)
        setMessages(msgPage.data, msgPage.total)

        // Opening a chat acknowledges any terminal chat-head state globally so
        // other devices stop showing a stale completed/stopped/error badge too.
        const existingHead = useStore.getState().chatHeads.find((h) => h.chatId === chatId)
        if (existingHead && (existingHead.status === 'completed' || existingHead.status === 'stopped' || existingHead.status === 'error')) {
          useStore.getState().deleteChatHead(chatId)
        }
        generateApi.acknowledge(chatId).catch(() => {})

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

        let openedCharacter: import('@/types/api').Character | null = null
        if (chat.character_id) {
          openedCharacter = useStore.getState().characters.find((c) => c.id === chat.character_id) ?? null
          if (!openedCharacter) {
            openedCharacter = await charactersApi.get(chat.character_id).catch(() => null)
            if (openedCharacter && !cancelled) {
              useStore.getState().updateCharacter(openedCharacter.id, openedCharacter)
            }
          }
        }

        // Character bindings are temporary chat-context overrides. When a chat
        // has no binding, fall back to the user's default persona instead of
        // leaking the previous chat's bound persona into the new chat.
        {
          const {
            characterPersonaBindings,
            personaTagBindings,
            personas: allPersonas,
            setActivePersona,
            activePersonaId,
          } = useStore.getState()
          const defaultPersonaId = allPersonas.find((p) => p.is_default)?.id ?? null
          const resolvedBinding = resolveAutoPersonaBinding({
            characterId: chat.character_id,
            characterTags: openedCharacter?.tags ?? [],
            personas: allPersonas,
            characterPersonaBindings,
            personaTagBindings,
          })
          const boundPersona = resolvedBinding.personaId
            ? allPersonas.find((p) => p.id === resolvedBinding.personaId) ?? null
            : null

          if (resolvedBinding.personaId && boundPersona) {
            if (activePersonaId !== resolvedBinding.personaId) {
              setActivePersona(resolvedBinding.personaId)
              toast.info(`Switched to persona: ${boundPersona.name}`)
            }
            autoSwitchedPersonaIdRef.current = resolvedBinding.personaId

          } else {
            const shouldRestoreDefault =
              autoSwitchedPersonaIdRef.current !== null &&
              defaultPersonaId !== null &&
              activePersonaId !== defaultPersonaId &&
              (activePersonaId === null || autoSwitchedPersonaIdRef.current === activePersonaId)

            if (shouldRestoreDefault) {
              setActivePersona(defaultPersonaId)
            }

            autoSwitchedPersonaIdRef.current = null
          }
        }

        // Auto-apply loadout if a binding exists for this chat/character
        try {
          const resolved = await loadoutsApi.resolve(chatId)
          if (resolved.loadout && !cancelled) {
            const { applyLoadout } = useStore.getState()
            await applyLoadout(resolved.loadout.id)
            toast.info(`Applied loadout: ${resolved.loadout.name}`)
          }
        } catch { /* no loadout binding — that's fine */ }

        try {
          const resolvedCouncil = await councilApi.resolve(chatId)
          if (!cancelled) {
            const store = useStore.getState()
            store.setCouncilSettings(resolvedCouncil.council_settings)
            store.setCouncilPersistenceTarget(councilSourceToTarget(resolvedCouncil.source, {
              chatId,
              characterId: chat.character_id,
            }))

            const memberPackIds = new Set(
              resolvedCouncil.council_settings.members.map((member) => member.packId).filter(Boolean),
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

        // Load per-chat wallpaper from metadata
        const wp = chat.metadata?.wallpaper as import('@/types/store').WallpaperRef | undefined
        if (wp?.image_id) {
          useStore.getState().setActiveChatWallpaper(wp)
        }

        // Restore active avatar override from metadata
        const avatarOverride = chat.metadata?.active_avatar_id as string | undefined
        useStore.getState().setActiveChatAvatarId(avatarOverride || null)

        // Detect group chat and initialize group state
        const isGroup = chat.metadata?.group === true
        const groupCharIds: string[] = isGroup ? (chat.metadata.character_ids || []) : []
        const mutedIds: string[] = isGroup ? (chat.metadata.muted_character_ids || []) : []

        // Restore active expression from chat metadata
        if (isGroup && groupCharIds.length > 0) {
          // Restore per-character group expressions
          const savedGroupExprs = chat.metadata?.group_expressions as Record<string, { label: string; imageId: string }> | undefined
          if (savedGroupExprs && Object.keys(savedGroupExprs).length > 0) {
            useStore.getState().setGroupExpressions(savedGroupExprs)
          } else {
            useStore.getState().clearGroupExpressions()
          }
          // Also restore the last single active_expression for the primary character
          const savedExpr = chat.metadata?.active_expression as string | undefined
          if (savedExpr && chat.character_id) {
            expressionsApi.get(chat.character_id).then((config) => {
              if (cancelled) return
              if (config?.enabled && config.mappings?.[savedExpr]) {
                useStore.getState().setActiveExpression(savedExpr, config.mappings[savedExpr], chat.character_id!)
              }
            }).catch(() => {})
          }
        } else {
          useStore.getState().clearGroupExpressions()
          const savedExpr = chat.metadata?.active_expression as string | undefined
          if (savedExpr && chat.character_id) {
            expressionsApi.get(chat.character_id).then((config) => {
              if (cancelled) return
              if (config?.enabled && config.mappings?.[savedExpr]) {
                useStore.getState().setActiveExpression(savedExpr, config.mappings[savedExpr], chat.character_id!)
              }
            }).catch(() => {})
          }
        }

        if (isGroup && groupCharIds.length > 0) {
          useStore.getState().setGroupChat(true, groupCharIds, mutedIds)
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
          // Refresh the active character on every chat open so profile/chat
          // surfaces don't rely on a stale cached avatar/image_id.
          if (chat.character_id) {
            if (openedCharacter) {
              if (!cancelled) useStore.getState().updateCharacter(openedCharacter.id, openedCharacter)
            } else {
              charactersApi.get(chat.character_id).then((char) => {
                if (!cancelled) useStore.getState().updateCharacter(char.id, char)
              }).catch(() => {})
            }
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
  }, [chatId, setActiveChat, setMessages])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setActiveChat(null)
      useStore.getState().clearGroupChat()
    }
  }, [setActiveChat])

  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)

  // Resolve effective wallpaper: per-chat overrides global
  const effectiveWallpaper = activeChatWallpaper ?? wallpaper.global
  const wallpaperUrl = effectiveWallpaper?.image_id ? imagesApi.url(effectiveWallpaper.image_id) : null
  const wallpaperIsVideo = effectiveWallpaper?.type === 'video'
  const wallpaperOpacity = wallpaper.opacity ?? 0.3
  const wallpaperFit = wallpaper.fit ?? 'cover'
  const hasAnyBackground = !!(sceneBackground || wallpaperUrl)

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

  // Sync bubble opt-out attributes so CSS can suppress effects.
  const bubbleDisableHover = useStore((s) => s.bubbleDisableHover)
  const bubbleHideAvatarBg = useStore((s) => s.bubbleHideAvatarBg)
  useEffect(() => {
    const root = document.documentElement
    if (bubbleDisableHover) root.setAttribute('data-no-bubble-hover', '')
    else root.removeAttribute('data-no-bubble-hover')
    if (bubbleHideAvatarBg) root.setAttribute('data-no-bubble-avatar-bg', '')
    else root.removeAttribute('data-no-bubble-avatar-bg')
    return () => {
      root.removeAttribute('data-no-bubble-hover')
      root.removeAttribute('data-no-bubble-avatar-bg')
    }
  }, [bubbleDisableHover, bubbleHideAvatarBg])

  if (!chatId) return null

  return (
    <div
      data-component="ChatView"
      className={clsx(
        styles.container,
        isStreaming && styles.streaming,
        (sceneBackground || wallpaperUrl) && styles.hasSceneBackground
      )}
    >
      {/* Wallpaper layer (z-index 0) — lowest background, overridden by scene */}
      {wallpaperUrl && !wallpaperIsVideo && (
        <div
          className={styles.wallpaperLayer}
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit,
            backgroundSize: wallpaperFit === 'fill' ? '100% 100%' : wallpaperFit,
          }}
        />
      )}
      {wallpaperUrl && wallpaperIsVideo && (
        <video
          ref={videoRef}
          className={styles.wallpaperVideoLayer}
          src={wallpaperUrl}
          autoPlay
          muted
          loop
          playsInline
          style={{
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit === 'fill' ? 'fill' : wallpaperFit,
          }}
        />
      )}

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
      <div className={styles.body} {...(chatWidthMode !== 'full' ? { 'data-chat-constrained': '' } : {})}>
        {portraitPanelSide !== 'none' && portraitPanelSide === 'left' && (
          <div className={clsx(styles.portraitSide, styles.portraitSideLeft, portraitPanelOpen && styles.portraitSideOpen)}>
            <PortraitPanel side="left" />
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabLeft, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label="Toggle portrait panel"
            >
              <UserRound size={14} />
            </button>
          </div>
        )}

        <div className={styles.chatColumn}>
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
          <div className={styles.chatColumnInner} style={innerStyle} data-select-mode={messageSelectMode || undefined}>
            <div className={styles.chatToolbar}>
              <button
                type="button"
                className={clsx(styles.toolbarBtn, messageSelectMode && styles.toolbarBtnActive)}
                onClick={toggleSelectMode}
                title={messageSelectMode ? 'Exit selection mode' : 'Select messages'}
              >
                <ListChecks size={14} />
              </button>
            </div>
            <MessageList messages={messages} chatId={chatId} isStreaming={isStreaming} />
            <ScrollToBottom />
            <CouncilPill />
            {messageSelectMode && <MessageSelectBar chatId={chatId} />}
            <InputArea chatId={chatId} />
          </div>
        </div>

        {portraitPanelSide !== 'none' && portraitPanelSide === 'right' && (
          <div className={clsx(styles.portraitSide, styles.portraitSideRight, portraitPanelOpen && styles.portraitSideOpen)}>
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabRight, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label="Toggle portrait panel"
            >
              <UserRound size={14} />
            </button>
            <PortraitPanel side="right" />
          </div>
        )}
      </div>
      <ExpressionDisplay />
      <FloatingAvatarViewer />
    </div>
  )
}
