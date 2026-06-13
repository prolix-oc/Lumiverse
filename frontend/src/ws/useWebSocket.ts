import { useEffect, useRef } from 'react'
import { wsClient, WS_OPEN, WS_CLOSE, WS_PONG, WS_AUTH_ERROR } from './client'
import { EventType } from './events'
import { useStore } from '@/store'
import { hasUnsavedSettings } from '@/store/slices/settings'
import { routeBackendMessage, routeFrontendProcessEvent, loadFrontendExtension } from '@/lib/spindle/loader'
import { spindleApi } from '@/api/spindle'
import { messagesApi } from '@/api/chats'
import { imageGenApi } from '@/api/image-gen'
import { generateApi } from '@/api/generate'
import { operatorApi } from '@/api/operator'
import { presetsApi } from '@/api/presets'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import {
  invalidateDisplayRegexCache,
  invalidateDisplayRegexCacheForMessage,
  invalidateDisplayRegexCacheForVars,
} from '@/hooks/useDisplayRegex'
import { triggerTTSAutoPlay } from '@/hooks/useTTSAutoPlay'
import { recoverPooledGeneration, requestStreamGapRecovery } from '@/lib/generation-recovery'
import { checkForBundleUpdate } from '@/lib/swUpdater'
import type {
  StreamTokenPayload,
  GenerationStartedPayload,
  GenerationInProgressPayload,
  GenerationPhaseChangedPayload,
  GenerationEndedPayload,
  GenerationAcknowledgedPayload,
  MessageSentPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  MessageSwipedPayload,
  ChatChangedPayload,
  LumiPipelineStartedPayload,
  LumiModuleDonePayload,
  LumiPipelineCompletedPayload,
  GroupTurnStartedPayload,
  GroupRoundCompletePayload,
} from '@/types/ws-events'
import type { CouncilToolResult } from 'lumiverse-spindle-types'
import type { ActivatedWorldInfoEntry, WorldInfoStats } from '@/types/api'
import { playNotificationPing } from '@/lib/notificationAudio'

const LOCAL_STREAM_PLACEHOLDER_PREFIX = '__stream_placeholder_'
const LOCAL_REGEN_PLACEHOLDER_PREFIX = '__regen_placeholder_'

function isLocalStreamPlaceholderId(id: string | null | undefined) {
  return !!id && (
    id.startsWith(LOCAL_STREAM_PLACEHOLDER_PREFIX)
    || id.startsWith(LOCAL_REGEN_PLACEHOLDER_PREFIX)
  )
}

const MAX_TOAST_ERROR_LENGTH = 800
// Last-line-of-defense sanitizer for error strings rendered in toasts. The
// backend already strips HTML/oversize bodies from provider errors, but this
// keeps a misbehaving provider (or a stale backend) from wedging the toast
// layout with a 50KB Cloudflare 503 page.
function sanitizeToastMessage(raw: string | undefined | null): string {
  if (!raw) return 'Generation failed'
  const stripped = /<\w[^>]*>/.test(raw)
    ? raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : raw
  return stripped.length > MAX_TOAST_ERROR_LENGTH
    ? `${stripped.slice(0, MAX_TOAST_ERROR_LENGTH - 1)}…`
    : stripped
}

const MACRO_VARS_PREFIX = 'metadata.macro_variables.'
const CHAT_VARS_PREFIX = 'metadata.chat_variables.'

// Set on first SYSTEM_DISK_LOW receipt to silence the rebroadcasts the
// backend fires every 5 min while the disk stays over threshold. Module
// scope (not state) — survives WS reconnects, resets only on full page load.
let diskWarningShown = false

interface VarChangeSummary {
  bagWideVarChange: boolean
  changedVars: ReadonlySet<string>
}

function summarizeVarChanges(changedFields: readonly string[]): VarChangeSummary {
  const changedVars = new Set<string>()
  let sawBareBag = false
  for (const f of changedFields) {
    if (f === 'metadata.macro_variables' || f === 'metadata.chat_variables') {
      sawBareBag = true
      continue
    }
    if (f.startsWith(MACRO_VARS_PREFIX)) {
      const tail = f.slice(MACRO_VARS_PREFIX.length)
      const dot = tail.indexOf('.')
      if (dot > 0) changedVars.add(`${tail.slice(0, dot)}:${tail.slice(dot + 1)}`)
    } else if (f.startsWith(CHAT_VARS_PREFIX)) {
      changedVars.add(`chat:${f.slice(CHAT_VARS_PREFIX.length)}`)
    }
  }
  // Bare bag path is bag-wide only when no leaves describe the change (BE emits both).
  const bagWideVarChange = sawBareBag && changedVars.size === 0
  return { bagWideVarChange, changedVars }
}

/**
 * Fetch the latest messages using the tail endpoint (single request).
 * Returns the last N messages from the chat, where N is the user's messagesPerPage setting.
 */
function fetchLatestMessages(chatId: string) {
  const pageSize = useStore.getState().messagesPerPage || 50
  return messagesApi.list(chatId, { limit: pageSize, tail: true })
}

/**
 * Push the current extension-registered drawer tab list to the backend so
 * `spindle.ui.getDrawerTabs()` can enumerate them. Built-in drawer tabs are
 * mirrored backend-side; only extension tabs need to be synced.
 */
function sendDrawerTabRegistrySnapshot(drawerTabs: ReadonlyArray<{
  id: string
  extensionId: string
  title: string
  shortName?: string
  description?: string
  keywords?: string[]
}>) {
  wsClient.send({
    type: 'SPINDLE_UI_REGISTRY_SYNC',
    drawerTabs: drawerTabs.map((t) => ({
      id: t.id,
      extensionId: t.extensionId,
      tabName: t.title,
      shortName: t.shortName,
      tabDescription: t.description,
      keywords: t.keywords,
    })),
  })
}

async function refreshLoomRegistry() {
  const result = await presetsApi.listRegistry({ provider: 'loom', limit: 200 })
  useStore.getState().setLoomRegistry(Object.fromEntries(
    result.data.map((preset) => [
      preset.id,
      {
        name: preset.name,
        blockCount: preset.block_count,
        updatedAt: preset.updated_at,
        isDefault: false,
      },
    ]),
  ))
}

export function useWebSocket() {
  const store = useStore
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const userRole = useStore((s) => s.user?.role)
  const activeChatId = useStore((s) => s.activeChatId)
  const lastExtensionSyncAtRef = useRef(0)
  const lastOperatorUpdateToastKeyRef = useRef<string | null>(null)
  /**
   * Set to true when the socket closes after we'd already had a fully healthy
   * connection — i.e. an actual drop, not the initial connect. The next pong
   * that completes the recovery will trigger one bundle-update check and clear
   * the flag, so checks only fire on reconnect-after-drop.
   */
  const pendingReconnectCheckRef = useRef(false)

  useEffect(() => {
    if (!isAuthenticated) {
      lastOperatorUpdateToastKeyRef.current = null
      return
    }

    if (userRole !== 'owner' && userRole !== 'admin') {
      lastOperatorUpdateToastKeyRef.current = null
      return
    }

    let cancelled = false

    const syncOperatorStatus = async () => {
      try {
        const status = await operatorApi.getStatus()
        if (cancelled) return

        store.getState().setOperatorStatus(status)

        if (!status.updateAvailable) {
          lastOperatorUpdateToastKeyRef.current = null
          return
        }

        const toastKey = `${status.commitsBehind}:${status.latestUpdateMessage}`
        if (lastOperatorUpdateToastKeyRef.current === toastKey) return

        lastOperatorUpdateToastKeyRef.current = toastKey
        toast.info(
          i18n.t('common.toast.operatorUpdatesAvailable', {
            count: status.commitsBehind,
            suffix: status.latestUpdateMessage ? ` - ${status.latestUpdateMessage}` : '',
          }),
          { title: i18n.t('common.toast.operatorUpdateTitle'), duration: 7000 },
        )
      } catch {
        // Ignore transient operator status errors outside the Operator panel.
      }
    }

    syncOperatorStatus()
    const interval = window.setInterval(syncOperatorStatus, 30_000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [isAuthenticated, store, userRole])

  useEffect(() => {
    if (!isAuthenticated) return

    const syncExtensions = (force = false) => {
      const now = Date.now()
      if (!force && now - lastExtensionSyncAtRef.current < 1000) return
      lastExtensionSyncAtRef.current = now
      store.getState().loadExtensions()
    }

    // WS auth uses cookies — no token needed in the URL.
    // Connect only once; the singleton client handles reconnects internally.
    wsClient.connect()

    const unsubs = [
      // Connection lifecycle — drives the full-screen "Server connection lost"
      // overlay. Each disconnect resets all three signals; reconnect flips them
      // back to true (socket open → CONNECTED with role → pong received).
      wsClient.on(WS_OPEN, () => {
        store.getState().setWsConnected(true)
        // Push the current extension drawer-tab snapshot so the backend's
        // spindle.ui.getDrawerTabs() can enumerate extension-added tabs.
        sendDrawerTabRegistrySnapshot(store.getState().drawerTabs)
      }),
      wsClient.on(WS_CLOSE, () => {
        store.getState().setWsConnected(false)
        // If the user had a working connection before this close, remember to
        // ask the SW for a fresh bundle once we recover. Initial-load failures
        // (wsHasEverConnected still false) shouldn't trigger an update check.
        if (store.getState().wsHasEverConnected) {
          pendingReconnectCheckRef.current = true
        }
      }),
      wsClient.on(WS_PONG, () => {
        store.getState().setWsRoundTripVerified(true)
        if (pendingReconnectCheckRef.current) {
          pendingReconnectCheckRef.current = false
          checkForBundleUpdate()
        }
      }),
      wsClient.on(WS_AUTH_ERROR, () => {
        // Server has explicitly rejected our session — the cookie is invalid
        // (e.g. logged out elsewhere, server restart with cleared sessions).
        // Re-check the session so AuthGuard can redirect to /login instead of
        // leaving the user stuck behind the connection-lost overlay forever.
        store.getState().checkSession().catch(() => {
          /* AuthGuard reads isAuthenticated; checkSession sets it on failure */
        })
      }),

      wsClient.on(EventType.MESSAGE_SENT, (payload: MessageSentPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          if (payload.message?.id) invalidateDisplayRegexCacheForMessage(payload.message.id)

          // Suppress completed assistant messages while streaming — the streaming
          // card already displays the content. GENERATION_ENDED will reconcile
          // the full message list, preventing a duplicate bubble flash.
          if (state.isStreaming && !payload.message.is_user && payload.message.content) return

          // If streaming with a placeholder (regeneration), replace it with the
          // real staged message from the backend instead of adding a duplicate.
          if (
            state.isStreaming &&
            isLocalStreamPlaceholderId(state.regeneratingMessageId) &&
            !payload.message.is_user &&
            !payload.message.content
          ) {
            state.removeMessage(state.regeneratingMessageId)
            state.addMessage(payload.message)
            state.setRegeneratingMessageId(payload.message.id)
            return
          }

          // Normal send: backend stages an empty assistant message before generation.
          // Add it to the store and set it as the regenerating target so streaming
          // renders in-place on this card instead of spawning a duplicate ephemeral bubble.
          if (
            state.isStreaming &&
            !state.regeneratingMessageId &&
            !payload.message.is_user &&
            !payload.message.content
          ) {
            state.addMessage(payload.message)
            state.setRegeneratingMessageId(payload.message.id)
            return
          }

          state.addMessage(payload.message)
        }
      }),

      wsClient.on(EventType.MESSAGE_EDITED, (payload: MessageEditedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          if (payload.message?.id) invalidateDisplayRegexCacheForMessage(payload.message.id)

          // During a continue, the backend updates the target message with combined
          // content right before GENERATION_ENDED. Skip the update while streaming
          // to avoid a brief content duplication frame — reconciliation after
          // GENERATION_ENDED will pick up the final state.
          if (state.isStreaming && state.streamingGenerationType === 'continue') {
            const msgs = state.messages
            const lastAssistant = msgs.length > 0 ? msgs[msgs.length - 1] : null
            if (lastAssistant && !lastAssistant.is_user && lastAssistant.id === payload.message.id) {
              return
            }
          }
          state.updateMessage(payload.message.id, payload.message)
        }
      }),

      wsClient.on(EventType.MESSAGE_DELETED, (payload: MessageDeletedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.removeMessage(payload.messageId)
          if (payload.messageId) invalidateDisplayRegexCacheForMessage(payload.messageId)
        }
      }),

      wsClient.on(EventType.MESSAGE_SWIPED, (payload: MessageSwipedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.updateMessage(payload.message.id, payload.message)
          // Deleting a swipe shifts indices, so a pending "new swipe" pointer is
          // no longer trustworthy — drop it.
          if (payload.action === 'deleted' && payload.message?.id) {
            state.clearUnseenSwipe(payload.message.id)
          }
          if (payload.message?.id) invalidateDisplayRegexCacheForMessage(payload.message.id)
        }
      }),

      wsClient.on(EventType.CHAT_CHANGED, (payload: ChatChangedPayload) => {
        const state = store.getState()
        const changedChatId = payload.chat?.id ?? payload.chatId
        if (changedChatId !== state.activeChatId) return

        const changedFields = payload.changedFields
        if (changedFields === undefined) {
          invalidateDisplayRegexCache()
          return
        }
        const { bagWideVarChange, changedVars } = summarizeVarChanges(changedFields)
        if (changedVars.size > 0 && !bagWideVarChange) {
          invalidateDisplayRegexCacheForVars(changedVars)
          return
        }
        if (bagWideVarChange) {
          invalidateDisplayRegexCache()
        }
      }),

      wsClient.on(EventType.GENERATION_STARTED, (payload: GenerationStartedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          if (state.isGroupChat && payload.characterId) {
            state.setActiveGroupCharacter(payload.characterId)
            state.setRespondingCharacterId(payload.characterId)
          }
          if (state.activeGenerationId !== payload.generationId) {
            state.startStreaming(payload.generationId, payload.targetMessageId)
          } else if (payload.targetMessageId && state.regeneratingMessageId !== payload.targetMessageId) {
            // Generation already wired via HTTP response — just set the target message.
            // This happens when council sidecar stages a message after startStreaming was
            // called without a targetMessageId (e.g. regeneration flow).
            state.setRegeneratingMessageId(payload.targetMessageId)
          }
          // Anchor the streaming buffer to its swipe so the user can navigate to
          // other swipes mid-generation without smearing live tokens onto them.
          state.setStreamingSwipeId(payload.targetSwipeId ?? null)
          // A new generation supersedes any stale "new swipe ready" badge on this
          // message — the upcoming completion will re-flag the fresh swipe if needed.
          if (payload.targetMessageId) state.clearUnseenSwipe(payload.targetMessageId)
        }
        // Track as a chat head so it appears if user navigates away
        state.addChatHead({
          generationId: payload.generationId,
          chatId: payload.chatId,
          characterName: payload.characterName || 'Assistant',
          characterId: payload.characterId,
          avatarUrl: null, // resolved by the component via characterId
          status: 'assembling',
          model: '',
          startedAt: Date.now(),
        })
      }),

      wsClient.on(EventType.GENERATION_IN_PROGRESS, (payload: GenerationInProgressPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          if (state.activeGenerationId !== payload.generationId) {
            state.startStreaming(payload.generationId, payload.targetMessageId)
          } else if (payload.targetMessageId && state.regeneratingMessageId !== payload.targetMessageId) {
            state.setRegeneratingMessageId(payload.targetMessageId)
          }
          // Refine (never clobber) the swipe anchor — GENERATION_STARTED is the
          // authoritative source; only overwrite if this event actually carries it.
          if (payload.targetSwipeId != null) state.setStreamingSwipeId(payload.targetSwipeId)

          // Surface context clipping once the final assembly metadata is ready.
          const clip = payload.contextClipStats
          if (clip?.enabled && clip.budgetInvalid) {
            toast.error(
              i18n.t('common.toast.contextBudgetInvalid', { max: clip.maxContext.toLocaleString() }),
            )
          } else if (clip?.enabled && clip.fixedOverBudget) {
            toast.error(
              i18n.t('common.toast.contextFixedOverBudget', {
                fixed: clip.fixedTokens.toLocaleString(),
                over: Math.abs(clip.remainingHistoryBudget).toLocaleString(),
              }),
            )
          } else if (clip?.enabled && clip.remainingHistoryBudget <= 0 && clip.messagesDropped > 0) {
            toast.warning(i18n.t('common.toast.contextNoHistoryRoom'))
          } else if (clip?.enabled && clip.messagesDropped > 0) {
            toast.warning(
              i18n.t('common.toast.contextClipped', {
                count: clip.messagesDropped,
                messages: clip.messagesDropped,
                tokens: clip.tokensDropped.toLocaleString(),
              }),
            )
          }
        }

        state.updateChatHead(payload.generationId, {
          status: 'waiting',
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.characterName ? { characterName: payload.characterName } : {}),
          ...(payload.characterId ? { characterId: payload.characterId } : {}),
        })
      }),

      wsClient.on(EventType.GENERATION_PHASE_CHANGED, (payload: GenerationPhaseChangedPayload) => {
        const state = store.getState()
        if (payload.generationId) {
          const head = state.chatHeads.find((h) => h.generationId === payload.generationId)
          if (head && head.status !== payload.phase) {
            state.updateChatHead(payload.generationId, { status: payload.phase })
          }
        }
      }),

      wsClient.on(EventType.STREAM_TOKEN_RECEIVED, (payload: StreamTokenPayload) => {
        const state = store.getState()
        if (payload.generationId === state.activeGenerationId) {
          // `offset` (char position of the segment in the server's cumulative
          // buffer) gives exact reconciliation: overlap with recovery-backfilled
          // content is sliced off inside the append, and a segment starting
          // beyond our buffer means we missed tokens — pull the authoritative
          // pool immediately instead of waiting for the 4s watchdog.
          const result = payload.type === 'reasoning'
            ? state.appendStreamReasoning(payload.token, payload.offset)
            : state.appendStreamToken(payload.token, payload.offset)
          if (result === 'gap' && payload.chatId) {
            requestStreamGapRecovery(payload.chatId)
          }
        }
        // Phase transitions are now handled explicitly by GENERATION_PHASE_CHANGED
        // to ensure immediate updates globally across tabs without polling, instead
        // of relying on the stream token receiver to infer phase changes.
      }),

      wsClient.on(EventType.GENERATION_ENDED, (payload: GenerationEndedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          // Guard: ignore events from stale generations that were replaced by a newer one
          if (state.activeGenerationId && payload.generationId && payload.generationId !== state.activeGenerationId) return
          // Mark this generation as ended BEFORE calling endStreaming/setStreamingError,
          // so a late startStreaming() call (from pending HTTP response) won't resurrect it
          if (payload.generationId) {
            state.markGenerationEnded(payload.generationId)
          }

          if (payload.error) {
            // Remove client-side placeholder if regeneration failed before backend saved a real message
            const regenId = state.regeneratingMessageId
            if (isLocalStreamPlaceholderId(regenId)) {
              state.removeMessage(regenId)
            }
            state.setStreamingError(payload.error)
            // Drop any pending @mention chain so we don't spam-fire through failures
            if (state.mentionQueue && state.mentionQueue.chatId === payload.chatId) {
              state.setMentionQueue(null)
            }
            // Backend preserves any content that streamed before the failure
            // (socket drop, upstream 5xx, etc.) and returns its messageId.
            // Surface that in the toast so users know their partial response
            // wasn't lost — it'll appear in the chat after reconciliation.
            const partialSaved = !!payload.messageId && !!payload.content
            // Defense-in-depth: cap the toast message so a misbehaving provider
            // (Cloudflare 503 HTML page, etc.) cannot wedge the toast layout
            // even if it slips past the backend sanitizer.
            const safeError = sanitizeToastMessage(payload.error)
            toast.error(
              partialSaved
                ? i18n.t('common.toast.partialResponseSaved', { error: safeError })
                : safeError,
              { title: i18n.t('common.toast.generationFailedTitle') },
            )
            // Reconcile message list on error so any backend-staged empty messages
            // are reflected (or removed if the backend cleaned them up).
            if (payload.chatId) {
              fetchLatestMessages(payload.chatId).then((res) => {
                const s = store.getState()
                if (s.activeChatId === payload.chatId) {
                  s.setMessages(res.data, res.total)
                }
              }).catch(() => { /* ignore */ })
            }
          } else {
            // Cache breakdown data from WS event if present
            if (payload.messageId && (payload as any).breakdown) {
              const bd = (payload as any).breakdown
              state.cacheBreakdown(payload.messageId, {
                entries: bd.entries || [],
                totalTokens: bd.totalTokens || 0,
                maxContext: bd.maxContext || 0,
                model: bd.model || '',
                provider: bd.provider || '',
                parameters: bd.parameters,
                usage: bd.usage,
                presetName: bd.presetName,
                tokenizer_name: bd.tokenizer_name || null,
                chatId: payload.chatId,
              })
            }

            // Patch generation metrics onto the in-store message immediately so the
            // detail pill can display tokenCount/TTFT/TPS before reconciliation completes.
            if (payload.messageId && (payload.tokenCount != null || payload.generationMetrics)) {
              const msg = state.messages.find((m) => m.id === payload.messageId)
              if (msg) {
                state.updateMessage(payload.messageId, {
                  extra: {
                    ...msg.extra,
                    ...(payload.tokenCount != null ? { tokenCount: payload.tokenCount } : {}),
                    ...(payload.generationMetrics ? { generationMetrics: payload.generationMetrics } : {}),
                  },
                })
              }
            }

            // In group chats, mark the character as spoken and clear responding state
            if (state.isGroupChat && state.activeGroupCharacterId) {
              state.markCharacterSpoken(state.activeGroupCharacterId)
              state.setRespondingCharacterId(null)
            }

            // Increment app badge when generation completes while tab is hidden
            if (document.hidden) {
              store.getState().incrementBadgeCount()
            }

            if (payload.messageId && typeof payload.content === 'string') {
              // Resolve speaker name for voice routing: in group chats the
              // active group character is who just spoke; in single-char
              // chats it's the chat's owning character. AI generation is
              // always is_user=false.
              const characters = state.characters
              const speakerId = state.isGroupChat
                ? state.activeGroupCharacterId
                : state.activeCharacterId
              const speakerName = speakerId
                ? (characters.find((c) => c.id === speakerId)?.name ?? '')
                : ''
              triggerTTSAutoPlay({
                messageId: payload.messageId,
                content: payload.content,
                name: speakerName,
                isUser: false,
              })
            }

            // Impersonate draft: stash the streamed content for the input box
            // instead of reconciling messages (no message was created on the backend).
            if ((payload as any).impersonateDraft) {
              const draftContent = typeof payload.content === 'string' ? payload.content : state.streamingContent
              state.endStreaming()
              state.setImpersonateDraftContent(draftContent)
              state.deleteChatHead(payload.chatId)
              generateApi.acknowledge(payload.chatId).catch(() => {})
              return
            }

            const optimisticMessageId = state.regeneratingMessageId
            // Captured before endStreaming clears it: the swipe this generation
            // filled. If the user chose to stay on a different swipe, we flag the
            // fresh one as unseen so a "new swipe ready" badge points them to it.
            const completedSwipeId = state.streamingSwipeId
            const completedMessageId = payload.messageId

            // Reconcile before clearing streaming. Clearing first collapses long
            // streamed rows back to their blank/original content for a frame; on
            // mobile, if the user is reading inside a multi-viewport final row,
            // the browser clamps scrollTop toward the bottom and creates a
            // visible snapdown before the saved message arrives.
            // Image gen is deferred until AFTER reconciliation completes so its
            // backend work (sidecar LLM scene analysis, DB reads) cannot delay
            // message delivery and cause a perceived UI stall.
            fetchLatestMessages(payload.chatId).then((res) => {
              const s = store.getState()
              if (s.activeChatId === payload.chatId) {
                s.setMessages(res.data, res.total)
                if (completedSwipeId != null && completedMessageId) {
                  const msg = res.data.find((m) => m.id === completedMessageId)
                  // Only badge when there's actually another swipe to navigate to
                  // and the user isn't already viewing the freshly-generated one.
                  if (msg && msg.swipes.length > 1 && completedSwipeId < msg.swipes.length && msg.swipe_id !== completedSwipeId) {
                    s.setUnseenSwipe(completedMessageId, completedSwipeId)
                  }
                }
                s.endStreaming()
              }
            }).catch(() => {
              store.getState().endStreaming()
              if (isLocalStreamPlaceholderId(optimisticMessageId)) {
                store.getState().removeMessage(optimisticMessageId)
              }
            }).finally(() => {
              const latest = store.getState()
              // Drain the @mention queue — kick off the next mentioned member's
              // turn. Skips if the active chat no longer matches, the queue is
              // for a different chat, or a new generation has already started.
              const queue = latest.mentionQueue
              if (
                queue &&
                queue.chatId === payload.chatId &&
                queue.ids.length > 0 &&
                !latest.isStreaming &&
                latest.activeChatId === payload.chatId
              ) {
                const nextId = latest.shiftMentionQueue()
                if (nextId) {
                  latest.beginStreaming()
                  generateApi.start({
                    chat_id: queue.chatId,
                    connection_id: queue.opts.connection_id,
                    persona_id: queue.opts.persona_id,
                    persona_addon_states: queue.opts.persona_addon_states,
                    preset_id: queue.opts.preset_id,
                    force_preset_id: queue.opts.force_preset_id,
                    target_character_id: nextId,
                    generation_type: 'normal',
                  }).then((res) => {
                    const s = store.getState()
                    if (s.activeChatId === queue.chatId) {
                      s.startStreaming(res.generationId)
                    }
                  }).catch((err) => {
                    console.error('[MentionQueue] Failed to start next generation:', err)
                    const s = store.getState()
                    s.setStreamingError(
                      err?.body?.error || err?.message || i18n.t('errors.failedMentionChain'),
                    )
                    s.setMentionQueue(null)
                    s.stopStreaming()
                  })
                  return
                }
              }

              // Don't trigger image gen if a new generation already started,
              // we're in a group nudge loop, or the user has navigated away
              // from the chat that just finished generating (the backend would
              // still create the attachment message, but the local store would
              // silently drop it because the active chat no longer matches).
              if (
                !latest.isStreaming &&
                !latest.isNudgeLoopActive &&
                latest.activeChatId === payload.chatId &&
                latest.imageGeneration.enabled &&
                latest.imageGeneration.autoGenerate !== false &&
                !latest.sceneGenerating
              ) {
                const ig = latest.imageGeneration
                const outputTarget = ig.outputTarget || 'background'
                // attach_to_message needs the just-finalized AI message as its
                // target; fall back to the last message in the store if the
                // event didn't carry one. Skip the auto-gen entirely when we
                // can't resolve a target so the backend's required-id check
                // doesn't surface as a user-facing error.
                let attachToMessageId: string | undefined
                if (outputTarget === 'attach_to_message') {
                  attachToMessageId =
                    payload.messageId ||
                    (latest.messages.length > 0 ? latest.messages[latest.messages.length - 1].id : undefined)
                  if (!attachToMessageId) return
                }
                // Pass settings from the live store rather than relying on the
                // backend's persisted row — settings flushes are debounced
                // ~1.5s, so without this a reply sent right after a toggle
                // would auto-gen with the previous values.
                latest.setSceneGenerating(true)
                imageGenApi.generate({
                  chatId: payload.chatId,
                  forceGeneration: !!ig.forceGeneration,
                  outputTarget,
                  attachToMessageId,
                  promptMode: ig.promptMode,
                  prompt: ig.customPrompt,
                  negativePrompt: ig.customNegativePrompt,
                  promptPresetId: ig.activePromptPresetId ?? null,
                  promptGenerationTimeoutSeconds: ig.promptGenerationTimeoutSeconds,
                  generationTimeoutSeconds: ig.generationTimeoutSeconds,
                }).then((res) => {
                  if (outputTarget === 'background' && res.generated && res.imageDataUrl) {
                    store.getState().setSceneBackground(res.imageDataUrl)
                  }
                }).catch((err) => {
                  console.warn('[ImageGen] Auto-generate failed:', err)
                }).finally(() => {
                  store.getState().setSceneGenerating(false)
                })
              }
            })
          }
        }
        // Transition chat head to terminal state (it auto-dismisses after a delay).
        // If the user is currently viewing this chat, dismiss & acknowledge instead —
        // otherwise the persisted 'completed' head would spawn the moment they navigate away.
        if (payload.chatId && payload.generationId) {
          if (payload.chatId === state.activeChatId) {
            state.deleteChatHead(payload.chatId)
            generateApi.acknowledge(payload.chatId).catch(() => {})
          } else {
            state.updateChatHead(payload.generationId, {
              status: payload.error ? 'error' : 'completed',
            })
            // Ping when a backgrounded chat finishes successfully
            if (!payload.error && state.chatHeadsEnabled && state.chatHeadsCompletionSoundEnabled) {
              playNotificationPing(state.chatHeadsCustomCompletionSound?.uploadedAt ?? null)
            }
          }
        }
      }),

      wsClient.on(EventType.GENERATION_STOPPED, (payload: { generationId?: string; chatId?: string }) => {
        const state = store.getState()
        // Guard: only stop streaming if this event matches the active generation
        // (a newer generation may have already replaced it)
        if (state.activeGenerationId && payload.generationId && payload.generationId !== state.activeGenerationId) return
        // User stop also cancels any pending @mention chain for this chat
        if (state.mentionQueue && payload.chatId && state.mentionQueue.chatId === payload.chatId) {
          state.setMentionQueue(null)
        }
        // Mark as ended to prevent zombie resurrection from late HTTP responses
        if (payload.generationId) {
          state.markGenerationEnded(payload.generationId)
        }
        // Reset council executing state in case stop fired during council tools
        if (state.councilExecuting) {
          state.setCouncilExecuting(false)
        }
        // Delay stopStreaming until after message reconciliation completes.
        // This keeps the streaming bubble visible while the HTTP fetch runs,
        // then both updates (stop streaming + set messages) happen in a single
        // React render — no flash of empty content.
        const chatId = payload?.chatId || state.activeChatId
        if (chatId) {
          fetchLatestMessages(chatId).then((res) => {
            const s = store.getState()
            if (s.activeChatId === chatId) {
              s.stopStreaming()
              s.setMessages(res.data, res.total)
            } else {
              s.stopStreaming()
            }
          }).catch(() => {
            store.getState().stopStreaming()
          })
        } else {
          state.stopStreaming()
        }
        // Transition chat head to stopped state (auto-dismisses after a delay).
        // If the user is viewing this chat, dismiss & acknowledge instead so it
        // doesn't reappear when they navigate away.
        if (payload.chatId && payload.generationId) {
          if (payload.chatId === state.activeChatId) {
            state.deleteChatHead(payload.chatId)
            generateApi.acknowledge(payload.chatId).catch(() => {})
          } else {
            state.updateChatHead(payload.generationId, { status: 'stopped' })
          }
        }
      }),

      wsClient.on(EventType.GENERATION_ACKNOWLEDGED, (payload: GenerationAcknowledgedPayload) => {
        if (!payload.chatId) return
        store.getState().deleteChatHead(payload.chatId)
      }),

      wsClient.on(EventType.GENERATION_ERROR, () => {
        const state = store.getState()
        const regenId = state.regeneratingMessageId
        if (isLocalStreamPlaceholderId(regenId)) {
          state.removeMessage(regenId)
        }
        state.stopStreaming()
      }),

      // Group chat events
      wsClient.on(EventType.GROUP_TURN_STARTED, (payload: GroupTurnStartedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId && state.isGroupChat) {
          state.setActiveGroupCharacter(payload.characterId)
          state.setNudgeLoopActive(true)
          state.startStreaming(payload.generationId)
          if (payload.totalExpected > 0) {
            // Update round total if the backend tells us
            if (state.roundTotal !== payload.totalExpected) {
              state.startNewRound(payload.totalExpected)
            }
          }
        }
      }),

      wsClient.on(EventType.GROUP_ROUND_COMPLETE, (payload: GroupRoundCompletePayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId && state.isGroupChat) {
          state.setNudgeLoopActive(false)
          state.setActiveGroupCharacter(null)
          // Mark all spoken characters
          for (const id of payload.charactersSpoken) {
            state.markCharacterSpoken(id)
          }
        }
      }),

      wsClient.on(EventType.CONNECTED, (payload: { role?: string }) => {
        // The client emits CONNECTED twice per connection: once locally from
        // onopen with an empty payload, and once when the backend's CONNECTED
        // message arrives (carrying the user role). Only the second one means
        // auth has been verified server-side — gate auth-sync on `role`.
        if (payload?.role) {
          store.getState().reconcileRole(payload.role)
          store.getState().setWsAuthSynced(true)
          // Immediately verify round-trip so the overlay can dismiss without
          // waiting up to 30s for the next scheduled ping.
          wsClient.forcePing()
        }
        syncExtensions(true)

        // Re-sync settings on every WS (re)connect. Covers two cases:
        // 1. Page refresh: the old page's keepalive flush may have landed after
        //    this page's initial loadSettings() — re-reading picks up those values.
        // 2. Server restart while page is open: settings may have been written by
        //    another tab or the server itself while we were disconnected.
        if (!hasUnsavedSettings()) {
          store.getState().loadSettings()
        }

        // Re-sync any pooled generation for the active chat. Covers sockets
        // that were killed during backgrounding (mobile OS suspend, long tab
        // switch) — tokens streamed while we were offline are pulled from the
        // server pool and segment offsets de-dupe the live WS replay exactly.
        const activeChatId = store.getState().activeChatId
        if (activeChatId) {
          recoverPooledGeneration(activeChatId).catch(() => { /* best-effort */ })
        }
        store.getState().reconcileChatHeads().catch(() => { /* best-effort */ })
      }),

      // Re-sync settings when another tab (or the old page's keepalive flush)
      // writes to the settings table. Skip if this tab has pending writes to
      // avoid overwriting in-flight local changes with stale DB values.
      wsClient.on(EventType.SETTINGS_UPDATED, () => {
        if (!hasUnsavedSettings()) {
          store.getState().loadSettings()
        }
      }),

      wsClient.on(EventType.CHARACTER_CREATED, (payload: { id: string; character?: import('@/types/api').Character }) => {
        if (payload?.character) {
          store.getState().updateCharacter(payload.id, payload.character)
        }
      }),

      wsClient.on(EventType.CHARACTER_EDITED, (payload: { id: string; character?: import('@/types/api').Character }) => {
        if (payload?.character) {
          store.getState().updateCharacter(payload.id, payload.character)
        }
      }),

      wsClient.on(EventType.CHARACTER_DELETED, (payload: { id: string }) => {
        store.getState().removeCharacter(payload.id)
      }),

      wsClient.on(EventType.PERSONA_CHANGED, (payload: { id: string; persona?: import('@/types/api').Persona; deleted?: boolean }) => {
        if (payload?.deleted) {
          store.getState().removePersona(payload.id)
          return
        }
        if (payload?.persona) {
          store.getState().updatePersona(payload.id, payload.persona)
        }
      }),

      // World Info activation
      wsClient.on(EventType.WORLD_INFO_ACTIVATED, (payload: { chatId: string; entries: ActivatedWorldInfoEntry[]; stats?: WorldInfoStats }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setActivatedWorldInfo(payload.entries, payload.stats)
        }
      }),

      // Council events
      wsClient.on(EventType.COUNCIL_STARTED, (payload: { chatId?: string }) => {
        const state = store.getState()
        state.setCouncilExecuting(true)
        state.setCouncilToolResults([])
        state.setCouncilExecutionResult(null)
        state.setCouncilToolsFailure(null)
        // Transition the chat head from assembling → council
        if (payload?.chatId) {
          const head = state.chatHeads.find((h) => h.chatId === payload.chatId)
          if (head) state.updateChatHead(head.generationId, { status: 'council' })
        }
      }),

      wsClient.on(EventType.COUNCIL_MEMBER_DONE, (payload: { results: CouncilToolResult[] }) => {
        const state = store.getState()
        state.setCouncilToolResults([...state.councilToolResults, ...payload.results])
      }),

      wsClient.on(EventType.COUNCIL_COMPLETED, (payload: { totalDurationMs: number; resultCount: number }) => {
        const state = store.getState()
        state.setCouncilExecuting(false)
        state.setCouncilExecutionResult({
          results: state.councilToolResults,
          deliberationBlock: '',
          totalDurationMs: payload.totalDurationMs,
        })
      }),

      // Lumi Pipeline events
      wsClient.on(EventType.LUMI_PIPELINE_STARTED, (payload: LumiPipelineStartedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setLumiExecuting(true)
          state.clearLumiResults()
        }
      }),

      wsClient.on(EventType.LUMI_MODULE_DONE, (payload: LumiModuleDonePayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.addLumiResult(payload)
        }
      }),

      wsClient.on(EventType.LUMI_PIPELINE_COMPLETED, (payload: LumiPipelineCompletedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setLumiExecuting(false)
          state.setLumiPipelineResult(payload)
        }
      }),

      // Spindle extension events
      wsClient.on(EventType.SPINDLE_EXTENSION_LOADED, () => {
        syncExtensions()
        // Extension may have registered new tools — refresh council tool list
        useStore.getState().loadAvailableTools()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_UNLOADED, (payload: { extensionId?: string }) => {
        if (payload.extensionId) {
          store.getState().clearExtensionThemeOverride(payload.extensionId)
        }
        syncExtensions()
        // Extension tools may have been removed — refresh council tool list
        useStore.getState().loadAvailableTools()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_ERROR, (payload: { extensionId: string; error: string }) => {
        console.error(`[Spindle] Extension error (${payload.extensionId}):`, payload.error)
        toast.error(payload.error, { title: i18n.t('common.toast.extensionErrorTitle') })
        syncExtensions()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_STATUS, (payload: { extensionId?: string; operation: string; name?: string }) => {
        useStore.getState().setExtensionOperationStatus(
          payload.extensionId ?? null,
          payload.operation,
          payload.name ?? null
        )
        if (payload.operation === 'updated' && payload.extensionId) {
          // Force a list refresh so the status dot reflects the post-restart state
          syncExtensions(true)
          const ext = useStore.getState().extensions.find((e) => e.id === payload.extensionId)
          if (ext?.enabled && ext?.has_frontend) {
            spindleApi.clearManifestCache(payload.extensionId)
            spindleApi.getManifest(payload.extensionId, { force: true })
              .then((manifest) => loadFrontendExtension(payload.extensionId!, manifest, true))
              .catch((err) => console.error('[Spindle] Failed to reload frontend after update:', err))
          }
        }
      }),

      wsClient.on(EventType.SPINDLE_BULK_UPDATE_PROGRESS, (payload: { total: number; completed: number; failed: number; currentExtensionId?: string; currentName?: string; phase?: string }) => {
        useStore.getState().setBulkUpdateStatus({
          total: payload.total,
          completed: payload.completed,
          failed: payload.failed,
          currentExtensionId: payload.currentExtensionId,
          currentName: payload.currentName,
        })
      }),

      wsClient.on(EventType.SPINDLE_RUNTIME_STATS, (payload: {
        extensionId: string
        identifier: string
        name: string
        runtimeMode: 'worker' | 'process' | 'sandbox'
        phase: 'startup' | 'sample' | 'shutdown'
        pid: number | null
        rssKb: number | null
        startupMs?: number
      }) => {
        console.info('[Spindle] Runtime stats:', payload)
      }),

      wsClient.on(EventType.SPINDLE_BULK_UPDATE_COMPLETE, (payload: { total: number; updated: number; failed: number; errors: Array<{ id: string; name: string; error: string }> }) => {
        const { total, updated, failed, errors } = payload
        useStore.getState().setBulkUpdateStatus({
          total,
          completed: updated,
          failed,
          done: true,
          errors,
        })
        if (total === 0) {
          toast.info(i18n.t('common.toast.extensionsNoneToUpdate'))
        } else if (failed === 0) {
          toast.success(i18n.t('common.toast.extensionsUpdated', { count: updated }))
        } else if (updated === 0) {
          toast.error(i18n.t('common.toast.extensionsAllFailed', { count: failed }))
          console.error('[Spindle] Bulk update errors:', errors)
        } else {
          toast.warning(i18n.t('common.toast.extensionsPartial', { updated, failed }))
          console.error('[Spindle] Bulk update errors:', errors)
        }
        // Pick up new version metadata in the list
        useStore.getState().loadExtensions()
        // Clear progress state a few seconds after completion
        setTimeout(() => {
          const current = useStore.getState().bulkUpdateStatus
          if (current?.done) useStore.getState().setBulkUpdateStatus(null)
        }, 3000)
      }),

      wsClient.on(EventType.SPINDLE_FRONTEND_MSG, (payload: { extensionId: string; data: unknown }) => {
        routeBackendMessage(payload.extensionId, payload.data)
      }),

      wsClient.on(EventType.SPINDLE_FRONTEND_PROCESS, (payload: { extensionId: string } & Record<string, unknown>) => {
        if (!payload?.extensionId || typeof payload.action !== 'string' || typeof payload.processId !== 'string') return
        if (payload.action === 'spawn' && typeof payload.kind === 'string') {
          routeFrontendProcessEvent(payload.extensionId, {
            action: 'spawn',
            processId: payload.processId,
            kind: payload.kind,
            key: typeof payload.key === 'string' ? payload.key : undefined,
            payload: payload.payload,
            metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata as Record<string, unknown> : undefined,
          })
          return
        }
        if (payload.action === 'message') {
          routeFrontendProcessEvent(payload.extensionId, {
            action: 'message',
            processId: payload.processId,
            payload: payload.payload,
          })
          return
        }
        if (payload.action === 'stop') {
          routeFrontendProcessEvent(payload.extensionId, {
            action: 'stop',
            processId: payload.processId,
            reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          })
        }
      }),

      wsClient.on(EventType.SPINDLE_TEXT_EDITOR_OPEN, (payload: { requestId: string; extensionId: string; title: string; value: string; placeholder: string }) => {
        store.getState().openTextEditor(payload)
      }),

      wsClient.on(EventType.SPINDLE_MODAL_OPEN, (payload: any) => {
        store.getState().openSpindleModal(payload)
      }),

      wsClient.on(EventType.SPINDLE_MODAL_RESULT, (payload: any) => {
        // Server-initiated close (programmatic dismiss via handleModalClose).
        // Use dismissSpindleModal (no WS echo) rather than closeSpindleModal.
        store.getState().dismissSpindleModal(payload.requestId)
      }),

      wsClient.on(EventType.SPINDLE_CONFIRM_OPEN, (payload: any) => {
        store.getState().openSpindleConfirm(payload)
      }),

      wsClient.on(EventType.SPINDLE_INPUT_PROMPT_OPEN, (payload: any) => {
        store.getState().openInputPrompt(payload)
      }),

      wsClient.on(EventType.SPINDLE_TOAST, (payload: { extensionId: string; extensionName: string; type: 'success' | 'warning' | 'error' | 'info'; message: string; title?: string; duration?: number }) => {
        const toastFn = toast[payload.type]
        if (!toastFn) return
        const attributedTitle = payload.title
          ? `${payload.extensionName}: ${payload.title}`
          : payload.extensionName
        toastFn(payload.message, { title: attributedTitle, duration: payload.duration })
      }),

      wsClient.on(EventType.SYSTEM_DISK_LOW, (payload: { path: string; usagePercent: number; freeBytes: number; totalBytes: number; thresholdPercent: number }) => {
        // Backend re-emits this on every 5-min interval while the disk is
        // over threshold so late-connecting admins still get notified. Dedupe
        // here so existing sessions only see one toast per page-load.
        if (diskWarningShown) return
        diskWarningShown = true
        const formatBytes = (bytes: number): string => {
          const GIB = 1024 * 1024 * 1024
          const MIB = 1024 * 1024
          if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`
          if (bytes >= MIB) return `${(bytes / MIB).toFixed(0)} MiB`
          return `${bytes} B`
        }
        const pct = (payload.usagePercent * 100).toFixed(0)
        const free = formatBytes(payload.freeBytes)
        toast.warning(
          `The disk hosting Lumiverse is ${pct}% full (${free} free). Free up space to avoid crashes — writes to memory-mapped files may fault if the disk fills.`,
          { title: 'Storage almost full', duration: 30_000 },
        )
      }),

      wsClient.on(EventType.SPINDLE_THEME_OVERRIDES, (payload: { extensionId: string; extensionName: string; overrides: { paletteAccent?: { h: number; s: number; l: number }; variables?: Record<string, string>; variablesByMode?: { dark?: Record<string, string>; light?: Record<string, string> } } | null }) => {
        // Always record the latest payload so re-enabling a muted theme applies
        // immediately without waiting for the extension to re-fire. The theme
        // applicator skips overrides whose extensionId is in mutedExtensionThemes,
        // so muted entries stay invisible until the user re-enables them.
        const hasVars = payload.overrides?.variables && Object.keys(payload.overrides.variables).length > 0
        const hasModeVars = payload.overrides?.variablesByMode && (
          Object.keys(payload.overrides.variablesByMode.dark ?? {}).length > 0 ||
          Object.keys(payload.overrides.variablesByMode.light ?? {}).length > 0
        )
        if (hasVars || hasModeVars || payload.overrides?.paletteAccent) {
          store.getState().setExtensionThemeOverride({
            extensionId: payload.extensionId,
            extensionName: payload.extensionName,
            paletteAccent: payload.overrides?.paletteAccent,
            variables: payload.overrides!.variables ?? {},
            variablesByMode: payload.overrides!.variablesByMode,
          })
        } else {
          store.getState().clearExtensionThemeOverride(payload.extensionId)
        }
      }),

      wsClient.on(EventType.SPINDLE_CHAT_STYLE_MODE, (payload: { extensionId: string; extensionName: string; chatId: string | null; mode: 'bounded' | 'extension-relaxed' }) => {
        if (typeof payload?.extensionId !== 'string' || payload.extensionId.length === 0) return
        // chatId === null signals extension dispose, drop all of its claims.
        if (payload.chatId === null) {
          store.getState().clearExtensionChatStyleModes(payload.extensionId)
          return
        }
        if (typeof payload.chatId !== 'string' || payload.chatId.length === 0) return
        if (payload.mode !== 'bounded' && payload.mode !== 'extension-relaxed') return
        store.getState().setChatStyleMode(payload.chatId, payload.extensionId, payload.mode)
      }),

      wsClient.on(EventType.SPINDLE_COMMANDS_CHANGED, (payload: { extensionId: string; extensionName: string; commands: Array<{ id: string; label: string; description: string; keywords?: string[]; scope?: 'global' | 'chat' | 'chat-idle' | 'landing' | 'character' }> }) => {
        store.getState().setExtensionCommands({
          extensionId: payload.extensionId,
          extensionName: payload.extensionName,
          commands: payload.commands,
        })
      }),

      wsClient.on(EventType.SPINDLE_UI_NAVIGATE, (payload: { extensionId: string; extensionName: string; action: 'open_drawer_tab' | 'close_drawer' | 'open_settings' | 'close_settings' | 'open_command_palette' | 'close_command_palette'; tabId?: string; viewId?: string }) => {
        const s = store.getState()
        switch (payload.action) {
          case 'open_drawer_tab':
            if (payload.tabId) s.openDrawer(payload.tabId)
            break
          case 'close_drawer':
            s.closeDrawer()
            break
          case 'open_settings':
            s.openSettings(payload.viewId)
            break
          case 'close_settings':
            s.closeSettings()
            break
          case 'open_command_palette':
            s.openCommandPalette()
            break
          case 'close_command_palette':
            s.closeCommandPalette()
            break
        }
      }),

      // Legacy/event-bus bridge for message tag intercept notifications.
      // Some extensions emit MESSAGE_TAG_INTERCEPTED over WS and expect it
      // on the backend-message channel (ctx.onBackendMessage).
      wsClient.on(EventType.MESSAGE_TAG_INTERCEPTED, (payload: { extensionId?: string } & Record<string, unknown>) => {
        if (typeof payload?.extensionId === 'string' && payload.extensionId) {
          routeBackendMessage(payload.extensionId, payload)
        }
      }),

      // Chat deletion — remove lingering chat head so it doesn't navigate to a dead chat
      wsClient.on(EventType.CHAT_DELETED, (payload: { id: string }) => {
        if (payload?.id) {
          store.getState().deleteChatHead(payload.id)
        }
      }),

      // Regex script events — reload for multi-tab sync
      wsClient.on(EventType.REGEX_SCRIPT_CHANGED, () => {
        store.getState().loadRegexScripts()
      }),
      wsClient.on(EventType.REGEX_SCRIPT_DELETED, () => {
        store.getState().loadRegexScripts()
      }),

      // Expression change events
      wsClient.on(EventType.EXPRESSION_CHANGED, (payload: { chatId: string; characterId: string; label: string; imageId: string }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setActiveExpression(payload.label, payload.imageId, payload.characterId)
          // In group chats, also populate per-character expression map
          if (state.isGroupChat && payload.characterId) {
            state.setGroupExpression(payload.characterId, payload.label, payload.imageId)
          }
        }
      }),
      // LumiHub remote install notifications
      wsClient.on(EventType.LUMIHUB_INSTALL_STARTED, (payload: { characterName: string; source: string }) => {
        toast.info(i18n.t('common.toast.lumiHubInstalling', { name: payload.characterName }), { title: i18n.t('common.toast.lumiHubTitle') })
      }),
      wsClient.on(EventType.LUMIHUB_INSTALL_COMPLETED, (payload: { characterId: string; characterName: string; type?: string }) => {
        toast.success(i18n.t('common.toast.lumiHubInstalled', { name: payload.characterName }), { title: i18n.t('common.toast.lumiHubTitle') })
        if (payload.type === 'preset') {
          const state = store.getState()
          state.setLoomRegistry({
            ...state.loomRegistry,
            [payload.characterId]: {
              name: payload.characterName,
              blockCount: 0,
              updatedAt: Math.floor(Date.now() / 1000),
              isDefault: false,
            },
          })
          refreshLoomRegistry().catch((err) => {
            console.warn('[LumiHub] Failed to refresh Loom preset registry:', err)
          })
        } else if (payload.type === 'theme') {
          if (!hasUnsavedSettings()) {
            store.getState().loadSettings().catch((err) => {
              console.warn('[LumiHub] Failed to refresh theme settings:', err)
            })
          }
        }
      }),
      wsClient.on(EventType.LUMIHUB_INSTALL_FAILED, (payload: { characterName: string; error: string }) => {
        toast.error(i18n.t('common.toast.lumiHubInstallFailed', { name: payload.characterName, error: payload.error }), { title: i18n.t('common.toast.lumiHubTitle') })
      }),
      // SillyTavern Migration
      wsClient.on(EventType.MIGRATION_PROGRESS, (payload: any) => {
        store.getState().setMigrationProgress(payload)
      }),
      wsClient.on(EventType.MIGRATION_LOG, (payload: any) => {
        store.getState().addMigrationLog(payload)
      }),
      wsClient.on(EventType.MIGRATION_COMPLETED, (payload: any) => {
        store.getState().setMigrationCompleted(payload)
      }),
      wsClient.on(EventType.MIGRATION_FAILED, (payload: any) => {
        store.getState().setMigrationFailed(payload)
      }),
      // Operator panel
      wsClient.on(EventType.OPERATOR_LOG, (payload: any) => {
        if (payload?.entries) {
          store.getState().appendOperatorLogs(payload.entries)
        }
      }),
      wsClient.on(EventType.OPERATOR_STATUS, (payload: any) => {
        if (payload) {
          store.getState().setOperatorStatus(payload)
        }
      }),
      wsClient.on(EventType.OPERATOR_PROGRESS, (payload: any) => {
        if (payload) {
          const status = payload.status
          const inProgress = status !== 'complete' && status !== 'error'
          store.getState().setOperatorBusy(inProgress ? payload.operation : null)
          store.getState().setOperatorProgressMessage(inProgress ? (payload.message ?? null) : null)
        }
      }),

      // MCP Server events
      wsClient.on(EventType.MCP_SERVER_CONNECTED, (payload: { id: string; name: string; toolCount: number; tools: any[] }) => {
        store.getState().setMcpServerStatus(payload.id, {
          id: payload.id,
          connected: true,
          tool_count: payload.toolCount,
          tools: payload.tools,
        })
        toast.success(i18n.t('common.toast.mcpConnected', { count: payload.toolCount }), { title: i18n.t('common.toast.mcpServerTitle', { name: payload.name }) })
      }),
      wsClient.on(EventType.MCP_SERVER_DISCONNECTED, (payload: { id: string; name: string }) => {
        store.getState().setMcpServerStatus(payload.id, {
          id: payload.id,
          connected: false,
          tool_count: 0,
          tools: [],
        })
      }),
      wsClient.on(EventType.MCP_SERVER_ERROR, (payload: { id: string; name: string; error: string }) => {
        store.getState().setMcpServerStatus(payload.id, {
          id: payload.id,
          connected: false,
          tool_count: 0,
          tools: [],
          error: payload.error,
        })
        toast.error(payload.error, { title: i18n.t('common.toast.mcpServerTitle', { name: payload.name }) })
      }),
      wsClient.on(EventType.MCP_SERVER_CHANGED, (payload: { id: string; profile?: any; deleted?: boolean }) => {
        if (payload.deleted) {
          store.getState().removeMcpServer(payload.id)
        } else if (payload.profile) {
          store.getState().updateMcpServer(payload.id, payload.profile)
        }
      }),

      // Loom summary auto-summarization — backend summarize-pool signals so
      // the Summary UI flag stays in sync across tabs / chat switches.
      wsClient.on(EventType.SUMMARIZATION_STARTED, (payload: { chatId: string; generationId: string; startedAt: number }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setIsSummarizing(true)
        }
      }),
      wsClient.on(EventType.SUMMARIZATION_COMPLETED, (payload: { chatId: string; generationId: string }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setIsSummarizing(false)
        }
      }),
      wsClient.on(EventType.SUMMARIZATION_FAILED, (payload: { chatId: string; generationId: string; error: string }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setIsSummarizing(false)
        }
        console.warn(`[Summary] Generation failed for chat ${payload.chatId}:`, payload.error)
      }),
    ]

    // Re-sync pooled tokens whenever the tab becomes visible. Mobile PWAs and
    // background tabs may miss live STREAM_TOKEN_RECEIVED events while hidden
    // even when the WS stays open; the server pool is authoritative, so a
    // status poll on every visible transition restores all accumulated content
    // (segment offsets slice off anything the client already rendered).
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      const activeChatId = store.getState().activeChatId
      if (activeChatId) {
        recoverPooledGeneration(activeChatId).catch(() => { /* best-effort */ })
      }
      store.getState().reconcileChatHeads().catch(() => { /* best-effort */ })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Mobile browsers occasionally deliver the full token stream but miss or
    // delay the terminal WS event. While a chat is streaming, poll the pooled
    // status endpoint at a low frequency so a dropped GENERATION_ENDED/STOPPED
    // cannot leave the stop button stuck indefinitely.
    const recoveryWatchdog = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const state = store.getState()
      if (!state.isStreaming || !state.activeChatId) return
      recoverPooledGeneration(state.activeChatId).catch(() => { /* best-effort */ })
    }, 4000)

    const chatHeadReconcile = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const heads = store.getState().chatHeads
      if (!heads.some((h) => h.status === 'assembling' || h.status === 'council' || h.status === 'council_failed' || h.status === 'reasoning' || h.status === 'streaming')) return
      store.getState().reconcileChatHeads().catch(() => { /* best-effort */ })
    }, 4000)

    // Re-sync the drawer-tab registry whenever extensions register or remove
    // a tab. Selector compares by id+title shape so unrelated state churn
    // (e.g. badge updates) doesn't trigger a redundant WS round-trip.
    const drawerTabsKey = (tabs: ReadonlyArray<{ id: string; title: string; extensionId: string }>) =>
      tabs.map((t) => `${t.id}:${t.extensionId}:${t.title}`).join('|')
    let lastDrawerTabsKey = drawerTabsKey(store.getState().drawerTabs)
    const unsubDrawerTabs = store.subscribe((state) => {
      const key = drawerTabsKey(state.drawerTabs)
      if (key === lastDrawerTabsKey) return
      lastDrawerTabsKey = key
      sendDrawerTabRegistrySnapshot(state.drawerTabs)
    })

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(recoveryWatchdog)
      clearInterval(chatHeadReconcile)
      unsubDrawerTabs()
      unsubs.forEach(unsub => unsub())
      wsClient.disconnect()
    }
  }, [isAuthenticated])

  useEffect(() => {
    wsClient.setFocusedChat(activeChatId)
  }, [activeChatId])
}
