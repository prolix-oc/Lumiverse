import { useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { messagesApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { useStore } from '@/store'
import type { Message } from '@/types/api'
import styles from './SwipeControls.module.css'
import clsx from 'clsx'

interface SwipeControlsProps {
  message: Message
  chatId: string
  variant?: 'default' | 'bubble'
}

export default function SwipeControls({ message, chatId, variant = 'default' }: SwipeControlsProps) {
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

  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isStreaming) return
    const nonce = ++regenerateNonceRef.current
    // Show streaming state immediately so the message shows the indicator
    beginStreaming(message.id)
    try {
      const genOpts: import('@/api/generate').GenerateRequest = {
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
      if (regenerateNonceRef.current !== nonce) return // stale response — a newer action took over
      startStreaming(res.generationId, message.id)
    } catch (err: any) {
      if (regenerateNonceRef.current !== nonce) return // stale error — a newer action took over
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
      const atFirst = message.swipe_id <= 0
      const atLast = message.swipe_id >= message.swipes.length - 1
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
        console.error('[SwipeControls] Failed to swipe:', err)
      }
    },
    [chatId, message.id, message.swipe_id, message.swipes.length, isLastAssistantMessage, handleRegenerate, updateMessage]
  )

  const current = message.swipe_id + 1
  const total = message.swipes.length
  const disableLeft = isStreaming || message.swipe_id <= 0
  const disableRight = isStreaming || (message.swipe_id >= total - 1 && !isLastAssistantMessage)

  return (
    <div className={clsx(styles.controls, variant === 'bubble' && styles.bubble)}>
      <button
        type="button"
        className={styles.btn}
        onClick={() => handleSwipe('left')}
        disabled={disableLeft}
        aria-label="Previous swipe"
      >
        <ChevronLeft size={14} />
      </button>
      <span className={styles.counter}>
        {current} / {total}
      </span>
      <button
        type="button"
        className={styles.btn}
        onClick={() => handleSwipe('right')}
        disabled={disableRight}
        aria-label="Next swipe"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
