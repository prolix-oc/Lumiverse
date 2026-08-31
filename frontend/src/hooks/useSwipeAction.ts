import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import {
  agentRuntimeErrorTranslationKey,
  agentRuntimePreflightTranslationKey,
} from '@/lib/agentRuntimeSelection'
import type { GenerateRequest } from '@/api/generate'
import { startGenerationWithRecovery } from '@/lib/generation-recovery'
import type { Message } from '@/types/api'

function fallbackErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const source = error as { body?: unknown; message?: unknown }
  const body = source.body && typeof source.body === 'object'
    ? source.body as { error?: unknown }
    : null
  return typeof body?.error === 'string'
    ? body.error
    : typeof source.message === 'string'
      ? source.message
      : undefined
}

export interface SwipeActionResult {
  handleSwipe: (direction: 'left' | 'right') => Promise<void>
  handleRegenerate: () => void
  atFirst: boolean
  atLast: boolean
  isLastAssistantMessage: boolean
  disableLeft: boolean
  disableRight: boolean
  /** True when this message is the one a generation is actively streaming into. */
  isStreamTarget: boolean
  /** Index of the swipe being streamed into (only when this message is the target). */
  liveSwipeId: number | null
}

/**
 * Shared hook for swipe navigation + regeneration logic.
 * Used by SwipeControls (buttons) and gesture/keyboard hooks.
 */
export default function useSwipeAction(message: Message, chatId: string): SwipeActionResult {
  const { t: te } = useTranslation('errors')
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const regeneratingMessageId = useStore((s) => s.regeneratingMessageId)
  const streamingSwipeId = useStore((s) => s.streamingSwipeId)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)
  const beginStreaming = useStore((s) => s.beginStreaming)
  const startStreaming = useStore((s) => s.startStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const setStreamingSwipeId = useStore((s) => s.setStreamingSwipeId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const mpRoomId = useStore((s) => s.mpRoomId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const openModal = useStore((s) => s.openModal)

  const isLastAssistantMessage = !message.is_user && messages.length > 0 && messages[messages.length - 1].id === message.id
  const generationAbortControllerRef = useRef<AbortController | null>(null)
  const regenerateNonceRef = useRef(0)

  // Is THIS message the one currently being streamed into?
  const isStreamTarget = isStreaming && (
    regeneratingMessageId === message.id ||
    (streamingGenerationType === 'continue' && isLastAssistantMessage)
  )
  const liveSwipeId = isStreamTarget ? streamingSwipeId : null

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  // Existing swipe navigation is safe while another swipe streams. Only the
  // trailing action that would start a generation is disabled.
  const disableLeft = atFirst
  const disableRight = atLast && (!isLastAssistantMessage || isStreaming)
  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isStreaming || useStore.getState().activeChatId !== chatId) return
    const nonce = ++regenerateNonceRef.current
    generationAbortControllerRef.current?.abort()
    const generationAbortController = new AbortController()
    generationAbortControllerRef.current = generationAbortController
    beginStreaming(message.id, 'swipe')
    setStreamingSwipeId(message.swipes.length)
    try {
      const presetId = getActivePresetForGeneration() || undefined
      const targetCharacterId = typeof message.extra?.character_id === 'string'
        ? message.extra.character_id
        : activeCharacterId
      const forceResponse = isGroupChat || !!mpRoomId
      const genOpts: GenerateRequest = {
        chat_id: chatId,
        message_id: message.id,
        swipe_id: message.swipes.length,
        generation_type: 'swipe',
        mode: forceResponse ? 'response' : undefined,
        connection_id: activeProfileId || undefined,
        persona_id: activeChatMetadata?.temporary ? undefined : activePersonaId || undefined,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        target_character_id: targetCharacterId || undefined,
      }
      if (feedback) {
        genOpts.regen_feedback = feedback
        genOpts.regen_feedback_position = regenFeedback.position
        genOpts.regen_feedback_format = regenFeedback.format
      }
      const res = await startGenerationWithRecovery('start', genOpts, {
        forceResponse,
        signal: generationAbortController.signal,
      })
      if (
        regenerateNonceRef.current !== nonce
        || useStore.getState().activeChatId !== chatId
      ) return
      startStreaming(res.generationId, message.id, 'swipe')
    } catch (err: unknown) {
      if (
        regenerateNonceRef.current !== nonce
        || useStore.getState().activeChatId !== chatId
      ) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      const runtimeKey = agentRuntimeErrorTranslationKey(err)
        ?? agentRuntimePreflightTranslationKey(err)
      const msg = runtimeKey
        ? i18n.t(runtimeKey, { ns: 'chat' })
        : fallbackErrorMessage(err) || te('failedToRegenerate')
      setStreamingError(msg)
    } finally {
      if (generationAbortControllerRef.current === generationAbortController) {
        generationAbortControllerRef.current = null
      }
    }
  }, [
    te,
    isStreaming,
    chatId,
    message.id,
    message.swipes.length,
    message.extra?.character_id,
    isGroupChat,
    mpRoomId,
    activeProfileId,
    activePersonaId,
    activeChatMetadata?.temporary,
    activeCharacterId,
    getActivePresetForGeneration,
    regenFeedback.position,
    regenFeedback.format,
    beginStreaming,
    startStreaming,
    setStreamingError,
    setStreamingSwipeId,
  ])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
        chatId,
        onSubmit: (feedback: string) => doRegenerate(feedback),
        onSkip: () => doRegenerate(),
      })
    } else {
      doRegenerate()
    }
  }, [isStreaming, regenFeedback.enabled, openModal, doRegenerate, chatId])

  const handleSwipe = useCallback(
    async (direction: 'left' | 'right') => {
      if (direction === 'left' && atFirst) return
      if (direction === 'right' && atLast) {
        // The trailing edge of the last assistant message spawns a new swipe —
        // but not while a generation is already running (that would abort it).
        if (isLastAssistantMessage && !isStreaming) {
          await handleRegenerate()
        }
        return
      }

      try {
        await messagesApi.swipe(chatId, message.id, direction)
      } catch (err) {
        console.error('[useSwipeAction] Failed to swipe:', err)
      }
    },
    [chatId, message.id, atFirst, atLast, isLastAssistantMessage, isStreaming, handleRegenerate]
  )

  return { handleSwipe, handleRegenerate, atFirst, atLast, isLastAssistantMessage, disableLeft, disableRight, isStreamTarget, liveSwipeId }
}

/**
 * Standalone swipe execution for use outside React component tree (e.g. keyboard hook).
 * Reads store state directly via getState().
 */
export async function executeSwipe(message: Message, chatId: string, direction: 'left' | 'right'): Promise<void> {
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  const isLastAssistant = !message.is_user && state.messages.length > 0 && state.messages[state.messages.length - 1].id === message.id

  if (direction === 'left' && atFirst) return
  if (direction === 'right' && atLast && !isLastAssistant) return

  if (direction === 'right' && atLast && isLastAssistant) {
    // Spawning a new swipe is the only swipe action blocked mid-generation.
    if (state.isStreaming) return
    const {
      regenFeedback,
      openModal,
      beginStreaming,
      startStreaming,
      setStreamingError,
      setStreamingSwipeId,
      activeProfileId,
      activePersonaId,
      activeCharacterId,
      activeChatMetadata,
      isGroupChat,
      mpRoomId,
      getActivePresetForGeneration,
    } = state

    const doRegen = async (feedback?: string | null) => {
      if (useStore.getState().activeChatId !== chatId) return
      const generationAbortController = new AbortController()
      beginStreaming(message.id, 'swipe')
      setStreamingSwipeId(message.swipes.length)
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const targetCharacterId = typeof message.extra?.character_id === 'string'
          ? message.extra.character_id
          : activeCharacterId
        const forceResponse = isGroupChat || !!mpRoomId
        const genOpts: GenerateRequest = {
          chat_id: chatId,
          message_id: message.id,
          swipe_id: message.swipes.length,
          generation_type: 'swipe',
          mode: forceResponse ? 'response' : undefined,
          connection_id: activeProfileId || undefined,
          persona_id: activeChatMetadata?.temporary ? undefined : activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
          target_character_id: targetCharacterId || undefined,
        }
        if (feedback) {
          genOpts.regen_feedback = feedback
          genOpts.regen_feedback_position = regenFeedback.position
          genOpts.regen_feedback_format = regenFeedback.format
        }
        const res = await startGenerationWithRecovery('start', genOpts, {
          forceResponse,
          signal: generationAbortController.signal,
        })
        const latest = useStore.getState()
        if (
          latest.activeChatId !== chatId
          || !latest.isStreaming
          || latest.regeneratingMessageId !== message.id
          || latest.streamingGenerationType !== 'swipe'
        ) return
        startStreaming(res.generationId, message.id, 'swipe')
      } catch (err: unknown) {
        const latest = useStore.getState()
        if (latest.activeChatId !== chatId) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        const runtimeKey = agentRuntimeErrorTranslationKey(err)
          ?? agentRuntimePreflightTranslationKey(err)
        const msg = runtimeKey
          ? i18n.t(runtimeKey, { ns: 'chat' })
          : fallbackErrorMessage(err) || i18n.t('errors.failedToRegenerate')
        setStreamingError(msg)
      }
    }

    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
        chatId,
        onSubmit: (feedback: string) => doRegen(feedback),
        onSkip: () => doRegen(),
      })
    } else {
      await doRegen()
    }
    return
  }

  try {
    await messagesApi.swipe(chatId, message.id, direction)
  } catch (err) {
    console.error('[executeSwipe] Failed to swipe:', err)
  }
}
