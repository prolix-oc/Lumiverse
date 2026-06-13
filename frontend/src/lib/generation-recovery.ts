import { generateApi } from '@/api/generate'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'

function getLocalStreamingType(generationType?: string) {
  return generationType === 'impersonate' ? 'impersonate_draft' : generationType
}

/**
 * Poll the backend generation pool for a chat and re-sync local streaming
 * state. Safe to call repeatedly — the pool is authoritative and cumulative,
 * and `reconcileStreamContent/Reasoning` apply snapshots monotonically (a
 * snapshot that raced newer live WS tokens can never rewind the buffer).
 *
 * When already streaming the same generation, the local buffer lengths are
 * sent with the poll so the server returns only the unseen tail (delta)
 * instead of re-shipping the full accumulated content every time.
 *
 * Triggered on: initial chat load, tab becoming visible, WS reconnect, a
 * lightweight watchdog poll while a generation is active, and immediately
 * when a live segment's offset reveals a gap in the local buffer.
 */
export async function recoverPooledGeneration(chatId: string): Promise<void> {
  if (!chatId) return
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return

  // Request a delta when we already hold a prefix of this generation's
  // buffers. The server only honors the lengths if the generationId matches,
  // so a stale id degrades safely to a full snapshot.
  let known: { generationId: string; contentLen: number; reasoningLen: number } | undefined
  if (state.isStreaming && state.activeGenerationId) {
    const buffers = state.getStreamBuffers()
    known = {
      generationId: state.activeGenerationId,
      contentLen: buffers.content.length,
      reasoningLen: buffers.reasoning.length,
    }
  }

  let genStatus
  try {
    genStatus = await generateApi.getStatus(chatId, known)
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
    if (genStatus.content) latest.reconcileStreamContent(genStatus.content, genStatus.contentOffset ?? 0)
    if (genStatus.reasoning) latest.reconcileStreamReasoning(genStatus.reasoning, genStatus.reasoningOffset ?? 0)
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

    // The draft needs the FULL content. A delta response only carries the
    // tail, so reconstruct from the local buffer prefix it was sliced
    // against — and do it before endStreaming() clears those buffers.
    let draftContent: string | null = null
    if (completedImpersonateDraft && typeof genStatus.content === 'string') {
      const offset = genStatus.contentOffset ?? 0
      draftContent = offset > 0
        ? latest.getStreamBuffers().content.slice(0, offset) + genStatus.content
        : genStatus.content
    }

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

    if (draftContent != null) {
      latest.setImpersonateDraftContent(draftContent)
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

// ── Gap recovery ─────────────────────────────────────────────────────────────
// Fired when a live WS segment's offset is ahead of the local buffer (we
// missed tokens — reconnect subscription race, events dropped while hidden).
// Single-flight per chat: a burst of gapped segments while one poll is in
// flight collapses into that poll; if the gap persists, the next gapped
// segment after it settles triggers a fresh one.

const gapRecoveryInFlight = new Set<string>()

export function requestStreamGapRecovery(chatId: string): void {
  if (!chatId || gapRecoveryInFlight.has(chatId)) return
  gapRecoveryInFlight.add(chatId)
  recoverPooledGeneration(chatId)
    .catch(() => { /* best-effort */ })
    .finally(() => { gapRecoveryInFlight.delete(chatId) })
}
