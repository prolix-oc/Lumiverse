import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import {
  generateSummary,
  getLastSummarizedInfo,
  shouldAutoSummarize,
} from '@/lib/summary/service'
import { generateApi } from '@/api/generate'

/**
 * Always-mounted auto-summarization trigger. Lives at the App root so it runs
 * regardless of whether the Summary drawer tab is currently visible.
 *
 * Two concerns handled here:
 *
 * 1. **Background survival** — once a summary kicks off for a given chat, it
 *    completes even if the user navigates to another chat. All state used
 *    inside the kickoff is captured at effect-start; no live store reads that
 *    could flip when `activeChatId` changes.
 * 2. **Cross-tab/refresh recovery** — when a chat becomes active, we poll the
 *    backend's summarize-pool via `getSummarizeStatus` to see if a summary is
 *    already in flight for that chat (e.g. started in another tab, or before a
 *    page refresh). If so, we flip `isSummarizing` so the UI reflects reality.
 *    The backend emits `SUMMARIZATION_*` WS events which the summary slice
 *    listens for to resolve the flag once the pool terminates.
 */
export function useAutoSummarization() {
  const activeChatId = useStore((s) => s.activeChatId)
  // Use the authoritative chat length, not the currently loaded message window.
  const messageCount = useStore((s) => s.totalChatLength)
  const mode = useStore((s) => s.summarization.mode)
  const autoInterval = useStore((s) => s.summarization.autoInterval)
  const isStreaming = useStore((s) => s.isStreaming)
  const lastGenerationType = useStore((s) => s.lastCompletedGenerationType)

  // Per-chat in-flight tracking so the global `isSummarizing` flag is no longer
  // the sole gate. Multiple chats can be mid-summary across tabs; what matters
  // locally is whether *this tab* already kicked off a summary for this chat.
  const inFlightChatsRef = useRef(new Set<string>())
  const lastTriggerCountRef = useRef<{ chatId: string; count: number } | null>(null)

  // Recovery: when the active chat changes, ask the backend whether a summary
  // is currently in flight for it. The UI flag is global, so on chat switch we
  // need to re-sync it to match whatever the new chat's pool state says —
  // otherwise a leftover `true` from the previous chat would bleed into the
  // new one. The WS events will keep it in sync after this initial fetch.
  useEffect(() => {
    if (!activeChatId) return
    const chatId = activeChatId
    let cancelled = false
    ;(async () => {
      try {
        const status = await generateApi.getSummarizeStatus(chatId)
        if (cancelled) return
        // Only resolve the flag if the chat hasn't changed again in the meantime.
        if (useStore.getState().activeChatId !== chatId) return
        useStore.getState().setIsSummarizing(status.active)
      } catch {
        // Status endpoint failure shouldn't block anything — leave the flag as-is
        // and let the next summary attempt / WS event figure it out.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeChatId])

  useEffect(() => {
    if (mode !== 'auto') return
    if (!activeChatId) return
    if (isStreaming) return
    if (messageCount === 0) return
    // Don't trigger summarization from impersonate generations — they create
    // user messages that bump totalChatLength but aren't narrative content
    // worth summarizing over. The next real generation will trigger if needed.
    if (lastGenerationType === 'impersonate') return

    // Capture the values this effect tick is reasoning about. Everything the
    // kickoff does is keyed off these locals, not the live store.
    const chatId = activeChatId
    const capturedMessageCount = messageCount
    const capturedAutoInterval = autoInterval

    // Don't re-enter for the same (chat, count) if we already tried at this
    // exact state — prevents streaming-flag flips / unrelated renders from
    // stacking kickoffs.
    const lastTrigger = lastTriggerCountRef.current
    if (lastTrigger && lastTrigger.chatId === chatId && lastTrigger.count === capturedMessageCount) return

    // Don't stack a second summary for the same chat if this tab already has
    // one in flight. Summaries for *other* chats are independent.
    if (inFlightChatsRef.current.has(chatId)) return

    // If the UI flag is set by the recovery effect above or by a manual
    // summary, defer — we don't want to step on that.
    if (useStore.getState().isSummarizing) return

    const kickoff = async () => {
      inFlightChatsRef.current.add(chatId)
      try {
        const snapshot = useStore.getState()
        const current = snapshot.summarization
        if (current.mode !== 'auto') return
        if (snapshot.isSummarizing || snapshot.isStreaming) return

        const info = await getLastSummarizedInfo(chatId)
        const lastCount = info?.messageCount ?? 0

        if (!shouldAutoSummarize(capturedMessageCount, lastCount, capturedAutoInterval)) return

        // Record the trigger so the effect won't re-enter for the same (chat, count).
        lastTriggerCountRef.current = { chatId, count: capturedMessageCount }

        let connectionId: string | undefined
        if (current.apiSource === 'sidecar') {
          connectionId = undefined
        } else if (current.apiSource === 'dedicated' && current.dedicatedConnectionId) {
          connectionId = current.dedicatedConnectionId
        } else {
          connectionId = snapshot.activeProfileId || undefined
        }

        const character = snapshot.characters.find((c) => c.id === snapshot.activeCharacterId)
        const characterName = character?.name || 'Character'
        const activePersona = snapshot.personas.find((p) => p.id === snapshot.activePersonaId)
        const userName = activePersona?.name || 'User'

        useStore.getState().setIsSummarizing(true)
        try {
          await generateSummary({
            chatId,
            connectionId,
            messageContext: current.autoMessageContext,
            userName,
            characterName,
            systemPromptOverride: current.systemPromptOverride,
            userPromptOverride: current.userPromptOverride,
          })
        } catch (err) {
          console.error('[useAutoSummarization] Summary generation failed:', err)
        } finally {
          // The backend clears its pool entry and emits SUMMARIZATION_COMPLETED
          // before this returns. Only flip the local flag if the active chat
          // is still this one — otherwise a parallel summary on the new chat
          // could have claimed the flag already.
          const after = useStore.getState()
          if (after.activeChatId === chatId) {
            after.setIsSummarizing(false)
          }
        }
      } finally {
        inFlightChatsRef.current.delete(chatId)
      }
    }

    queueMicrotask(kickoff)
  }, [activeChatId, messageCount, mode, autoInterval, isStreaming, lastGenerationType])
}
