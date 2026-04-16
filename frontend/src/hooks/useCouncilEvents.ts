import { useEffect } from 'react'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import type { CouncilToolsFailedPayload } from '@/types/ws-events'
import { useStore } from '@/store'
import { generateApi } from '@/api/generate'
import type { CouncilToolResult } from 'lumiverse-spindle-types'
import type { CouncilToolsFailedInfo } from '@/types/store'

/** Open the council retry modal for a given failure payload. */
export function showCouncilRetryModal(payload: CouncilToolsFailedInfo) {
  const state = useStore.getState()
  const failedList = payload.failedTools
    .map((t) => `${t.memberName} / ${t.toolDisplayName}${t.error ? `: ${t.error}` : ''}`)
    .join('\n')

  state.openModal('confirm', {
    title: 'Council Tools Failed',
    message: `${payload.failedCount} of ${payload.failedCount + payload.successCount} council tool(s) failed:\n\n${failedList}\n\nWould you like to retry the failed tools or continue with the successful results?`,
    variant: 'warning',
    confirmText: 'Retry Failed',
    secondaryText: 'Continue Anyway',
    secondaryVariant: 'safe',
    onConfirm: () => {
      generateApi.councilRetry(payload.generationId, 'retry').catch(console.error)
      state.setCouncilToolsFailure(null)
    },
    onSecondary: () => {
      generateApi.councilRetry(payload.generationId, 'continue').catch(console.error)
      state.setCouncilToolsFailure(null)
    },
    onCancel: () => {
      generateApi.councilRetry(payload.generationId, 'continue').catch(console.error)
      state.setCouncilToolsFailure(null)
    },
  })
}

export function useCouncilEvents() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)

  useEffect(() => {
    if (!isAuthenticated) return

    const unsubs = [
      wsClient.on(EventType.COUNCIL_STARTED, () => {
        const state = useStore.getState()
        state.setCouncilExecuting(true)
        state.setCouncilToolResults([])
        state.setCouncilExecutionResult(null)
        state.setCouncilToolsFailure(null)
      }),

      wsClient.on(EventType.COUNCIL_MEMBER_DONE, (payload: { results: CouncilToolResult[] }) => {
        const state = useStore.getState()
        state.setCouncilToolResults([...state.councilToolResults, ...payload.results])
      }),

      wsClient.on(EventType.COUNCIL_COMPLETED, (payload: { totalDurationMs: number; resultCount: number }) => {
        const state = useStore.getState()
        state.setCouncilExecuting(false)
        state.setCouncilExecutionResult({
          results: state.councilToolResults,
          deliberationBlock: '',
          totalDurationMs: payload.totalDurationMs,
        })
      }),

      wsClient.on(EventType.COUNCIL_TOOLS_FAILED, (payload: CouncilToolsFailedPayload) => {
        const state = useStore.getState()
        state.setCouncilToolsFailure(payload)

        // Update the chat head to reflect the failure state
        state.updateChatHead(payload.generationId, { status: 'council_failed' })

        // Only show the modal immediately if the user is viewing this chat.
        // Otherwise the failure is stored and ChatView will present it on navigation.
        if (state.activeChatId === payload.chatId) {
          showCouncilRetryModal(payload)
        }
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [isAuthenticated])
}
