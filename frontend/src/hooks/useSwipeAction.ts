import { useCallback, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { generateApi, type GenerateRequest } from '@/api/generate'
import { useStore } from '@/store'
import type { Message } from '@/types/api'

export interface SwipeActionResult {
  handleSwipe: (direction: 'left' | 'right') => Promise<void>
  handleRegenerate: () => void
  atFirst: boolean
  atLast: boolean
  isLastAssistantMessage: boolean
  disableLeft: boolean
  disableRight: boolean
}

/**
 * Shared hook for swipe navigation + regeneration logic.
 * Used by SwipeControls (buttons) and gesture/keyboard hooks.
 */
export default function useSwipeAction(message: Message, chatId: string): SwipeActionResult {
  const updateMessage = useStore((s) => s.updateMessage)
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const beginStreaming = useStore((s) => s.beginStreaming)
  const startStreaming = useStore((s) => s.startStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const openModal = useStore((s) => s.openModal)

  const isLastAssistantMessage = !message.is_user && messages.length > 0 && messages[messages.length - 1].id === message.id
  const regenerateNonceRef = useRef(0)

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  const disableLeft = isStreaming || atFirst
  const disableRight = isStreaming || (atLast && !isLastAssistantMessage)

  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isStreaming) return
    const nonce = ++regenerateNonceRef.current
    beginStreaming(message.id)
    try {
      const genOpts: GenerateRequest = {
        chat_id: chatId,
        message_id: message.id,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
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
      const msg = err?.body?.error || err?.message || 'Failed to regenerate'
      setStreamingError(msg)
    }
  }, [
    isStreaming,
    chatId,
    message.id,
    activeProfileId,
    activePersonaId,
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
      if (direction === 'right' && atLast && isLastAssistantMessage) {
        await handleRegenerate()
        return
      }
      if (direction === 'right' && atLast) return

      try {
        const updated = await messagesApi.swipe(chatId, message.id, direction)
        updateMessage(message.id, updated)
      } catch (err) {
        console.error('[useSwipeAction] Failed to swipe:', err)
      }
    },
    [chatId, message.id, atFirst, atLast, isLastAssistantMessage, handleRegenerate, updateMessage]
  )

  return { handleSwipe, handleRegenerate, atFirst, atLast, isLastAssistantMessage, disableLeft, disableRight }
}

/**
 * Standalone swipe execution for use outside React component tree (e.g. keyboard hook).
 * Reads store state directly via getState().
 */
export async function executeSwipe(message: Message, chatId: string, direction: 'left' | 'right'): Promise<void> {
  const state = useStore.getState()
  if (state.isStreaming) return

  const atFirst = message.swipe_id <= 0
  const atLast = message.swipe_id >= message.swipes.length - 1
  const isLastAssistant = !message.is_user && state.messages.length > 0 && state.messages[state.messages.length - 1].id === message.id

  if (direction === 'left' && atFirst) return
  if (direction === 'right' && atLast && !isLastAssistant) return

  if (direction === 'right' && atLast && isLastAssistant) {
    const { regenFeedback, openModal, beginStreaming, startStreaming, setStreamingError, activeProfileId, activePersonaId, getActivePresetForGeneration } = state

    const doRegen = async (feedback?: string | null) => {
      beginStreaming(message.id)
      try {
        const genOpts: GenerateRequest = {
          chat_id: chatId,
          message_id: message.id,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
        }
        if (feedback) {
          genOpts.regen_feedback = feedback
          genOpts.regen_feedback_position = regenFeedback.position
        }
        const res = await generateApi.regenerate(genOpts)
        startStreaming(res.generationId, message.id)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || 'Failed to regenerate'
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
    const updated = await messagesApi.swipe(chatId, message.id, direction)
    state.updateMessage(message.id, updated)
  } catch (err) {
    console.error('[executeSwipe] Failed to swipe:', err)
  }
}
