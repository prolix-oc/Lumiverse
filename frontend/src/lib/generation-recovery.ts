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
const pendingRecoveries = new Map<string, Promise<void>>()

export function recoverPooledGeneration(chatId: string): Promise<void> {
  const state = useStore.getState()
  const buffers = state.getStreamBuffers()
  const key = JSON.stringify([state.user?.id, chatId, state.getGenerationEpoch(),
    state.isStreaming, state.activeGenerationId, buffers.content.length, buffers.reasoning.length,
    state.streamingNavigationPaused, state.mpRoomId, state.mpIsHost])
  const pending = pendingRecoveries.get(key)
  if (pending) return pending
  const work = recoverPooledGenerationOnce(chatId).finally(() => {
    if (pendingRecoveries.get(key) === work) pendingRecoveries.delete(key)
  })
  pendingRecoveries.set(key, work)
  return work
}

async function recoverPooledGenerationOnce(chatId: string): Promise<void> {
  if (!chatId) return
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return
  // Chat exit keeps one frozen stream frame mounted for its short animation.
  // Recovery must not resume writes into that fading subtree.
  if (state.streamingNavigationPaused) return
  // Until HTTP/WS identifies this request, the pool may still describe the
  // previous generation. It cannot confirm or finish an optimistic new swipe.
  if (state.isStreaming && !state.activeGenerationId) return
  const generationEpoch = state.getGenerationEpoch()

  // Multiplayer peers don't own the host's generation pool — they reconcile
  // purely from the re-broadcast WS event stream. Polling the pool would either
  // no-op (remote peer: a different backend instance) or, worse, re-fetch the
  // peer's own backend and wipe the live view (it holds no copy of the host's
  // chat). All recovery triggers — load, visibility, reconnect, gap — funnel
  // through here, so this single guard keeps peers safe everywhere.
  if (state.mpRoomId && !state.mpIsHost && state.mpChatId === chatId) return

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
  if (
    latest.activeChatId !== chatId ||
    latest.streamingNavigationPaused ||
    latest.getGenerationEpoch() !== generationEpoch ||
    latest.isStreaming !== state.isStreaming ||
    latest.activeGenerationId !== state.activeGenerationId
  ) return

  if (genStatus.active && genStatus.generationId) {
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId, getLocalStreamingType(genStatus.generationType), genStatus.renderMode)
    // startStreaming rejects already-ended generations. Do not attach their
    // swipe anchors or replay their buffers after that rejection.
    if (useStore.getState().activeGenerationId !== genStatus.generationId) return
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null, genStatus.backgroundSwipe === true)
  }

  if (
    genStatus.active && genStatus.generationId &&
    genStatus.status === 'council' &&
    genStatus.councilRetryPending &&
    genStatus.councilToolsFailure
  ) {
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

  if (genStatus.active && genStatus.renderMode === 'persisted-message' && genStatus.targetMessageId) {
    await refreshPersistedMessage(chatId, genStatus.targetMessageId)
    return
  }

  if (genStatus.active && genStatus.generationId && (genStatus.status === 'streaming' || genStatus.status === 'reasoning')) {
    if (genStatus.content) latest.reconcileStreamContent(genStatus.content, genStatus.contentOffset ?? 0)
    if (genStatus.reasoning) latest.reconcileStreamReasoning(genStatus.reasoning, genStatus.reasoningOffset ?? 0)
    if (genStatus.reasoningDurationMs) {
      useStore.setState({ streamingReasoningDuration: genStatus.reasoningDurationMs })
    } else if (genStatus.reasoningStartedAt) {
      latest.setStreamingReasoningStartedAt(genStatus.reasoningStartedAt)
    }
    return
  }

  if (!genStatus.active) {
    // A previous completion must not refresh the message list of a newer
    // stream, even when there is no streaming state to clear for that result.
    if (latest.activeGenerationId && latest.activeGenerationId !== genStatus.generationId) return
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

    if (latest.isStreaming) {
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

    if (genStatus.renderMode === 'persisted-message' && genStatus.targetMessageId) {
      await refreshPersistedMessage(chatId, genStatus.targetMessageId)
      return
    }
    if (!genStatus.completedMessageId) return

    const pageSize = latest.messagesPerPage || 50
    const beforeRefresh = useStore.getState()
    const refreshEpoch = beforeRefresh.getGenerationEpoch()
    try {
      const fresh = await messagesApi.list(chatId, { limit: pageSize, tail: true })
      const after = useStore.getState()
      if (
        after.activeChatId === chatId &&
        !after.streamingNavigationPaused &&
        !after.isStreaming &&
        after.getGenerationEpoch() === refreshEpoch &&
        after.activeGenerationId === beforeRefresh.activeGenerationId
      ) {
        after.setMessages(fresh.data, fresh.total)
      }
    } catch { /* best-effort */ }
  }
}

async function refreshPersistedMessage(chatId: string, messageId: string): Promise<void> {
  const before = useStore.getState()
  const epoch = before.getGenerationEpoch()
  const prior = before.messages.find(message => message.id === messageId)
  try {
    const message = await messagesApi.get(chatId, messageId)
    const current = useStore.getState()
    if (current.activeChatId === chatId && !current.streamingNavigationPaused && current.getGenerationEpoch() === epoch &&
        current.activeGenerationId === before.activeGenerationId && current.isStreaming === before.isStreaming &&
        current.messages.find(value => value.id === message.id) === prior) {
      if (prior) current.updateMessage(message.id, message)
      else current.addMessage(message)
    }
  } catch { /* Message deletion can race recovery. */ }
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
