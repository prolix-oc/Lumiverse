import { useCallback, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { generateApi, type GenerateRequest } from '@/api/generate'
import { useStore } from '@/store'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import { webllmManager } from '@/lib/webllm-manager'
import { uuidv7 } from '@/lib/uuid'
import { toast } from '@/lib/toast'
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

// WebLLM: Build a flat role/content array from the full message list, stopping
// just before `excludeId` (the message being re-generated). Loom markers are stripped.
function buildWebLLMHistoryUpTo(
  allMessages: Message[],
  excludeId: string,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = []
  for (const m of allMessages) {
    if (m.id === excludeId) break
    if (m.extra?._loom_inject) continue
    const content = typeof m.content === 'string' ? m.content : ''
    if (content) result.push({ role: m.is_user ? 'user' : 'assistant', content })
  }
  return result
}

/**
 * Shared hook for swipe navigation + regeneration logic.
 * Used by SwipeControls (buttons) and gesture/keyboard hooks.
 */
export default function useSwipeAction(message: Message, chatId: string): SwipeActionResult {
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const beginStreaming = useStore((s) => s.beginStreaming)
  const endStreaming = useStore((s) => s.endStreaming)
  const startStreaming = useStore((s) => s.startStreaming)
  const appendStreamToken = useStore((s) => s.appendStreamToken)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const updateMessage = useStore((s) => s.updateMessage)
  const addChatHead = useStore((s) => s.addChatHead)
  const deleteChatHead = useStore((s) => s.deleteChatHead)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
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

    // WebLLM: intercept swipe-regen before calling the backend
    const activeProfile = profiles.find((p) => p.id === activeProfileId)
    if (activeProfile?.provider === 'webllm') {
      if (!webllmManager.isAvailable()) {
        toast.error('WebGPU is not available on this device', { title: 'WebLLM Unavailable' })
        return
      }
      const modelId = activeProfile.model
      if (!modelId) {
        toast.error('No model selected on the WebLLM connection.', { title: 'WebLLM' })
        return
      }

      // Stream the new response into the existing message card
      beginStreaming(message.id)

      // Messages up to (not including) the one being re-generated
      const chatMessages = buildWebLLMHistoryUpTo(messages, message.id)

      const syntheticGenId = uuidv7()
      const characterId = typeof message.extra?.character_id === 'string' ? message.extra.character_id : undefined
      addChatHead({
        generationId: syntheticGenId,
        chatId,
        characterName: message.name || 'Assistant',
        characterId,
        avatarUrl: null,
        status: 'streaming',
        model: modelId,
        startedAt: Date.now(),
      })

      try {
        if (webllmManager.getCurrentModelId() !== modelId) {
          const loadToastId = toast.info(`Loading ${modelId}… (first use may take a minute)`, { duration: 120000, dismissible: false })
          await webllmManager.loadModel(modelId, () => {})
          toast.dismiss(loadToastId)
        }
        if (regenerateNonceRef.current !== nonce) { endStreaming(); deleteChatHead(chatId); return }

        const fullContent = await webllmManager.generateStream(
          chatMessages,
          (token) => { if (regenerateNonceRef.current === nonce) appendStreamToken(token) },
        )

        if (regenerateNonceRef.current !== nonce) { endStreaming(); deleteChatHead(chatId); return }

        endStreaming()
        deleteChatHead(chatId)

        // Update the existing message with the new generated content (overwrites current swipe).
        await messagesApi.update(chatId, message.id, { content: fullContent })
        updateMessage(message.id, { content: fullContent })
      } catch (err: any) {
        if (regenerateNonceRef.current !== nonce) return
        const msg = err?.message || 'WebLLM regeneration failed'
        setStreamingError(msg)
        toast.error(msg, { title: 'WebLLM Error' })
        endStreaming()
        deleteChatHead(chatId)
      }
      return
    }

    // Normal backend path
    beginStreaming(message.id)
    try {
      const presetId = getActivePresetForGeneration() || undefined
      const genOpts: GenerateRequest = {
        chat_id: chatId,
        message_id: message.id,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId),
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
    message.name,
    message.extra,
    messages,
    profiles,
    activeProfileId,
    activePersonaId,
    activeCharacterId,
    getActivePresetForGeneration,
    regenFeedback.position,
    beginStreaming,
    endStreaming,
    startStreaming,
    appendStreamToken,
    setStreamingError,
    updateMessage,
    addChatHead,
    deleteChatHead,
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
        await messagesApi.swipe(chatId, message.id, direction)
      } catch (err) {
        console.error('[useSwipeAction] Failed to swipe:', err)
      }
    },
    [chatId, message.id, atFirst, atLast, isLastAssistantMessage, handleRegenerate]
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
    const {
      regenFeedback, openModal,
      beginStreaming, endStreaming, startStreaming, appendStreamToken, setStreamingError,
      updateMessage, addChatHead, deleteChatHead,
      activeProfileId, profiles, activePersonaId, activeCharacterId, getActivePresetForGeneration,
    } = state

    const doRegen = async (feedback?: string | null) => {
      // WebLLM: intercept before backend call
      const activeProfile = profiles.find((p: any) => p.id === activeProfileId)
      if (activeProfile?.provider === 'webllm') {
        if (!webllmManager.isAvailable()) {
          toast.error('WebGPU is not available on this device', { title: 'WebLLM Unavailable' })
          return
        }
        const modelId = activeProfile.model
        if (!modelId) {
          toast.error('No model selected on the WebLLM connection.', { title: 'WebLLM' })
          return
        }

        beginStreaming(message.id)
        const chatMessages = buildWebLLMHistoryUpTo(state.messages, message.id)
        const syntheticGenId = uuidv7()
        const characterId = typeof message.extra?.character_id === 'string' ? message.extra.character_id : undefined
        addChatHead({
          generationId: syntheticGenId,
          chatId,
          characterName: message.name || 'Assistant',
          characterId,
          avatarUrl: null,
          status: 'streaming',
          model: modelId,
          startedAt: Date.now(),
        })

        try {
          if (webllmManager.getCurrentModelId() !== modelId) {
            const loadToastId = toast.info(`Loading ${modelId}… (first use may take a minute)`, { duration: 120000, dismissible: false })
            await webllmManager.loadModel(modelId, () => {})
            toast.dismiss(loadToastId)
          }

          const fullContent = await webllmManager.generateStream(
            chatMessages,
            (token) => appendStreamToken(token),
          )

          endStreaming()
          deleteChatHead(chatId)
          await messagesApi.update(chatId, message.id, { content: fullContent })
          updateMessage(message.id, { content: fullContent })
        } catch (err: any) {
          const msg = err?.message || 'WebLLM regeneration failed'
          setStreamingError(msg)
          toast.error(msg, { title: 'WebLLM Error' })
          endStreaming()
          deleteChatHead(chatId)
        }
        return
      }

      // Normal backend path
      beginStreaming(message.id)
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const genOpts: GenerateRequest = {
          chat_id: chatId,
          message_id: message.id,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId),
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
    await messagesApi.swipe(chatId, message.id, direction)
  } catch (err) {
    console.error('[executeSwipe] Failed to swipe:', err)
  }
}
