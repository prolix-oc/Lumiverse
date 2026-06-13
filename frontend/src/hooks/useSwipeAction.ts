import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { messagesApi } from '@/api/chats'
import { generateApi, type GenerateRequest } from '@/api/generate'
import { useStore } from '@/store'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import i18n from '@/i18n'
import type { Message } from '@/types/api'

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
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const openModal = useStore((s) => s.openModal)

  const isLastAssistantMessage = !message.is_user && messages.length > 0 && messages[messages.length - 1].id === message.id
  const regenerateNonceRef = useRef(0)

  // Is THIS message the one currently being streamed into?
  const isStreamTarget = isStreaming && (
    regeneratingMessageId === message.id ||
    (streamingGenerationType === 'continue' && isLastAssistantMessage)
  )
  const liveSwipeId = isStreamTarget ? streamingSwipeId : null

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  // Navigating between existing swipes never touches the active stream, so it
  // stays enabled mid-generation. The only blocked action is the one that would
  // START a new generation: swiping right past the last swipe of the last
  // assistant message while one is already in flight.
  const disableLeft = atFirst
  const disableRight = atLast && (!isLastAssistantMessage || isStreaming)

  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isStreaming) return
    const nonce = ++regenerateNonceRef.current
    beginStreaming(message.id)
    try {
      const presetId = getActivePresetForGeneration() || undefined
      const genOpts: GenerateRequest = {
        chat_id: chatId,
        message_id: message.id,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
      }
      if (feedback) {
        genOpts.regen_feedback = feedback
        genOpts.regen_feedback_position = regenFeedback.position
      }
      const res = await generateApi.regenerate(genOpts)
      if (regenerateNonceRef.current !== nonce) return
      startStreaming(res.generationId, message.id)
    } catch (err: any) {
      if (regenerateNonceRef.current !== nonce) return
      const msg = err?.body?.error || err?.message || te('failedToRegenerate')
      setStreamingError(msg)
    }
  }, [
    te,
    isStreaming,
    chatId,
    message.id,
    activeProfileId,
    activePersonaId,
    activeCharacterId,
    getActivePresetForGeneration,
    regenFeedback.position,
    beginStreaming,
    startStreaming,
    setStreamingError,
  ])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
        onSubmit: (feedback: string) => doRegenerate(feedback),
        onSkip: () => doRegenerate(),
      })
    } else {
      doRegenerate()
    }
  }, [isStreaming, regenFeedback.enabled, openModal, doRegenerate])

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

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  const isLastAssistant = !message.is_user && state.messages.length > 0 && state.messages[state.messages.length - 1].id === message.id

  if (direction === 'left' && atFirst) return
  if (direction === 'right' && atLast && !isLastAssistant) return

  if (direction === 'right' && atLast && isLastAssistant) {
    // Spawning a new swipe is the only swipe action blocked mid-generation.
    if (state.isStreaming) return
    const { regenFeedback, openModal, beginStreaming, startStreaming, setStreamingError, activeProfileId, activePersonaId, activeCharacterId, getActivePresetForGeneration } = state

    const doRegen = async (feedback?: string | null) => {
      beginStreaming(message.id)
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const genOpts: GenerateRequest = {
          chat_id: chatId,
          message_id: message.id,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        }
        if (feedback) {
          genOpts.regen_feedback = feedback
          genOpts.regen_feedback_position = regenFeedback.position
        }
        const res = await generateApi.regenerate(genOpts)
        startStreaming(res.generationId, message.id)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || i18n.t('errors.failedToRegenerate')
        setStreamingError(msg)
      }
    }

    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
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
