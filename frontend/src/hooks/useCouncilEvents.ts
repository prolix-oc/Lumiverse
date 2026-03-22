import { useEffect } from 'react'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import { useStore } from '@/store'
import type { CouncilToolResult } from 'lumiverse-spindle-types'

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
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [isAuthenticated])
}
