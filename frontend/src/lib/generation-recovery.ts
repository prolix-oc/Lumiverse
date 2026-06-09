import { generateApi } from '@/api/generate'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'

function getLocalStreamingType(generationType?: string) {
  return generationType === 'impersonate' ? 'impersonate_draft' : generationType
}

/**
 * Poll the backend generation pool for a chat and re-sync local streaming
 * state. Safe to call repeatedly — the pool is authoritative and cumulative,
 * so `replaceStreamContent` + `setLastPooledSeq` snap the local buffer to the
 * true server-side state and the watermark drops WS tokens already included.
 *
 * Triggered on: initial chat load, tab becoming visible, WS reconnect, and a
 * lightweight watchdog poll while a generation is active.
 */
export async function recoverPooledGeneration(chatId: string): Promise<void> {
  if (!chatId) return
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return

  let genStatus
  try {
    genStatus = await generateApi.getStatus(chatId)
  } catch {
    return
  }

  const latest = useStore.getState()
  if (latest.activeChatId !== chatId) return

   if (
    genStatus.active &&
    genStatus.generationId &&
    genStatus.status === 'council' &&
    genStatus.councilRetryPending &&
    genStatus.councilToolsFailure
  ) {
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId)
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    latest.setCouncilExecuting(false)

    const existingFailure = latest.councilToolsFailure
    if (existingFailure?.generationId !== genStatus.generationId) {
      latest.setCouncilToolsFailure(genStatus.councilToolsFailure)
      const { showCouncilRetryModal } = await import('@/hooks/useCouncilEvents')
      const current = useStore.getState()
      if (current.activeChatId === chatId) {
        showCouncilRetryModal(genStatus.councilToolsFailure)
      }
    }
    return
  }

  if (genStatus.active && genStatus.generationId && (genStatus.status === 'streaming' || genStatus.status === 'reasoning')) {
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId, getLocalStreamingType(genStatus.generationType))
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    if (genStatus.content) latest.replaceStreamContent(genStatus.content)
    if (genStatus.reasoning) latest.replaceStreamReasoning(genStatus.reasoning)
    if (genStatus.tokenSeq != null) latest.setLastPooledSeq(genStatus.tokenSeq)
    if (genStatus.reasoningDurationMs) {
      useStore.setState({ streamingReasoningDuration: genStatus.reasoningDurationMs })
    } else if (genStatus.reasoningStartedAt) {
      latest.setStreamingReasoningStartedAt(genStatus.reasoningStartedAt)
    }
    return
  }

  if (genStatus.active && genStatus.generationId) {
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId, getLocalStreamingType(genStatus.generationType))
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    return
  }

  if (!genStatus.active) {
    const completedImpersonateDraft =
      genStatus.status === 'completed' &&
      genStatus.generationType === 'impersonate' &&
      !genStatus.completedMessageId

    const sameGeneration = !latest.activeGenerationId || latest.activeGenerationId === genStatus.generationId
    if (latest.isStreaming && sameGeneration) {
      if (genStatus.error) {
        latest.setStreamingError(genStatus.error)
      } else if (completedImpersonateDraft) {
        latest.endStreaming()
      } else if (genStatus.completedMessageId) {
        latest.endStreaming()
      } else {
        latest.stopStreaming()
      }
    }

    if (completedImpersonateDraft && typeof genStatus.content === 'string') {
      latest.setImpersonateDraftContent(genStatus.content)
      return
    }

    if (!genStatus.completedMessageId) return

    const pageSize = latest.messagesPerPage || 50
    try {
      const fresh = await messagesApi.list(chatId, { limit: pageSize, tail: true })
      const after = useStore.getState()
      if (after.activeChatId === chatId) {
        after.setMessages(fresh.data, fresh.total)
      }
    } catch { /* best-effort */ }
  }
}
