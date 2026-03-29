import { useEffect, useRef } from 'react'
import { wsClient } from './client'
import { EventType } from './events'
import { useStore } from '@/store'
import { routeBackendMessage } from '@/lib/spindle/loader'
import { messagesApi } from '@/api/chats'
import { imageGenApi } from '@/api/image-gen'
import { toast } from '@/lib/toast'
import type {
  StreamTokenPayload,
  GenerationStartedPayload,
  GenerationEndedPayload,
  MessageSentPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  MessageSwipedPayload,
  LumiPipelineStartedPayload,
  LumiModuleDonePayload,
  LumiPipelineCompletedPayload,
  GroupTurnStartedPayload,
  GroupRoundCompletePayload,
} from '@/types/ws-events'
import type { CouncilToolResult } from 'lumiverse-spindle-types'
import type { ActivatedWorldInfoEntry, WorldInfoStats } from '@/types/api'

/**
 * Fetch the latest messages using the tail endpoint (single request).
 * Returns the last N messages from the chat, where N is the user's messagesPerPage setting.
 */
function fetchLatestMessages(chatId: string) {
  const pageSize = useStore.getState().messagesPerPage || 50
  return messagesApi.list(chatId, { limit: pageSize, tail: true })
}

export function useWebSocket() {
  const store = useStore
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const lastExtensionSyncAtRef = useRef(0)

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
      wsClient.on(EventType.MESSAGE_SENT, (payload: MessageSentPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          // Suppress completed assistant messages while streaming — the streaming
          // card already displays the content. GENERATION_ENDED will reconcile
          // the full message list, preventing a duplicate bubble flash.
          if (state.isStreaming && !payload.message.is_user && payload.message.content) return

          // If streaming with a placeholder (regeneration), replace it with the
          // real staged message from the backend instead of adding a duplicate.
          if (
            state.isStreaming &&
            state.regeneratingMessageId?.startsWith('__regen_placeholder_') &&
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
          state.updateMessage(payload.message.id, payload.message)
        }
      }),

      wsClient.on(EventType.MESSAGE_DELETED, (payload: MessageDeletedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.removeMessage(payload.messageId)
        }
      }),

      wsClient.on(EventType.MESSAGE_SWIPED, (payload: MessageSwipedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.updateMessage(payload.message.id, payload.message)
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
        }
      }),

      wsClient.on(EventType.STREAM_TOKEN_RECEIVED, (payload: StreamTokenPayload) => {
        const state = store.getState()
        if (payload.generationId === state.activeGenerationId) {
          if (payload.type === 'reasoning') {
            state.appendStreamReasoning(payload.token)
          } else {
            state.appendStreamToken(payload.token)
          }
        }
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
            if (regenId?.startsWith('__regen_placeholder_')) {
              state.removeMessage(regenId)
            }
            state.setStreamingError(payload.error)
            toast.error(payload.error, { title: 'Generation Failed' })
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
                presetName: bd.presetName,
                tokenizer_name: bd.tokenizer_name || null,
                chatId: payload.chatId,
              })
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

            // End streaming immediately, then reconcile the full message list
            // from backend source-of-truth to avoid id/index race conditions.
            // Image gen is deferred until AFTER reconciliation completes so its
            // backend work (sidecar LLM scene analysis, DB reads) cannot delay
            // message delivery and cause a perceived UI stall.
            state.endStreaming()
            fetchLatestMessages(payload.chatId).then((res) => {
              const s = store.getState()
              if (s.activeChatId === payload.chatId) {
                s.setMessages(res.data, res.total)
              }
            }).catch(() => { /* ignore */ }).finally(() => {
              const latest = store.getState()
              // Don't trigger image gen if a new generation already started,
              // or if we're in the middle of a group nudge loop.
              if (
                !latest.isStreaming &&
                !latest.isNudgeLoopActive &&
                latest.imageGeneration.enabled &&
                latest.imageGeneration.autoGenerate !== false &&
                !latest.sceneGenerating
              ) {
                latest.setSceneGenerating(true)
                imageGenApi.generate({
                  chatId: payload.chatId,
                  forceGeneration: !!latest.imageGeneration.forceGeneration,
                }).then((res) => {
                  if (res.generated && res.imageDataUrl) {
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
      }),

      wsClient.on(EventType.GENERATION_STOPPED, (payload: { generationId?: string; chatId?: string }) => {
        const state = store.getState()
        // Guard: only stop streaming if this event matches the active generation
        // (a newer generation may have already replaced it)
        if (state.activeGenerationId && payload.generationId && payload.generationId !== state.activeGenerationId) return
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
      }),

      wsClient.on(EventType.GENERATION_ERROR, () => {
        const state = store.getState()
        const regenId = state.regeneratingMessageId
        if (regenId?.startsWith('__regen_placeholder_')) {
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
        // Reconcile user role from the backend's DB-authoritative source.
        // This ensures the frontend never falls out of sync with the actual
        // role (e.g. if the HTTP session response omitted it).
        if (payload?.role) {
          store.getState().reconcileRole(payload.role)
        }
        syncExtensions(true)
      }),

      wsClient.on(EventType.CHARACTER_EDITED, (payload: { id: string; character?: import('@/types/api').Character }) => {
        if (payload?.character) {
          store.getState().updateCharacter(payload.id, payload.character)
        }
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
      wsClient.on(EventType.COUNCIL_STARTED, () => {
        const state = store.getState()
        state.setCouncilExecuting(true)
        state.setCouncilToolResults([])
        state.setCouncilExecutionResult(null)
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

      wsClient.on(EventType.SPINDLE_EXTENSION_UNLOADED, () => {
        syncExtensions()
        // Extension tools may have been removed — refresh council tool list
        useStore.getState().loadAvailableTools()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_ERROR, (payload: { extensionId: string; error: string }) => {
        console.error(`[Spindle] Extension error (${payload.extensionId}):`, payload.error)
        toast.error(payload.error, { title: 'Extension Error' })
        syncExtensions()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_STATUS, (payload: { extensionId?: string; operation: string; name?: string }) => {
        useStore.getState().setExtensionOperationStatus(
          payload.extensionId ?? null,
          payload.operation,
          payload.name ?? null
        )
      }),

      wsClient.on(EventType.SPINDLE_FRONTEND_MSG, (payload: { extensionId: string; data: unknown }) => {
        routeBackendMessage(payload.extensionId, payload.data)
      }),

      wsClient.on(EventType.SPINDLE_TEXT_EDITOR_OPEN, (payload: { requestId: string; extensionId: string; title: string; value: string; placeholder: string }) => {
        store.getState().openTextEditor(payload)
      }),

      wsClient.on(EventType.SPINDLE_MODAL_OPEN, (payload: any) => {
        store.getState().openSpindleModal(payload)
      }),

      wsClient.on(EventType.SPINDLE_CONFIRM_OPEN, (payload: any) => {
        store.getState().openSpindleConfirm(payload)
      }),

      wsClient.on(EventType.SPINDLE_TOAST, (payload: { extensionId: string; extensionName: string; type: 'success' | 'warning' | 'error' | 'info'; message: string; title?: string; duration?: number }) => {
        const toastFn = toast[payload.type]
        if (!toastFn) return
        const attributedTitle = payload.title
          ? `${payload.extensionName}: ${payload.title}`
          : payload.extensionName
        toastFn(payload.message, { title: attributedTitle, duration: payload.duration })
      }),

      wsClient.on(EventType.SPINDLE_THEME_OVERRIDES, (payload: { extensionId: string; extensionName: string; overrides: { variables?: Record<string, string>; variablesByMode?: { dark?: Record<string, string>; light?: Record<string, string> } } | null }) => {
        const hasVars = payload.overrides?.variables && Object.keys(payload.overrides.variables).length > 0
        const hasModeVars = payload.overrides?.variablesByMode && (
          Object.keys(payload.overrides.variablesByMode.dark ?? {}).length > 0 ||
          Object.keys(payload.overrides.variablesByMode.light ?? {}).length > 0
        )
        if (hasVars || hasModeVars) {
          store.getState().setExtensionThemeOverride({
            extensionId: payload.extensionId,
            extensionName: payload.extensionName,
            variables: payload.overrides!.variables ?? {},
            variablesByMode: payload.overrides!.variablesByMode,
          })
        } else {
          store.getState().clearExtensionThemeOverride(payload.extensionId)
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
        toast.info(`Installing "${payload.characterName}" from LumiHub...`, { title: 'LumiHub' })
      }),
      wsClient.on(EventType.LUMIHUB_INSTALL_COMPLETED, (payload: { characterId: string; characterName: string }) => {
        toast.success(`"${payload.characterName}" installed successfully`, { title: 'LumiHub' })
      }),
      wsClient.on(EventType.LUMIHUB_INSTALL_FAILED, (payload: { characterName: string; error: string }) => {
        toast.error(`Failed to install "${payload.characterName}": ${payload.error}`, { title: 'LumiHub' })
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
          store.getState().setOperatorBusy(
            status === 'complete' || status === 'error' ? null : payload.operation
          )
        }
      }),
    ]

    return () => {
      unsubs.forEach(unsub => unsub())
      wsClient.disconnect()
    }
  }, [isAuthenticated])
}
