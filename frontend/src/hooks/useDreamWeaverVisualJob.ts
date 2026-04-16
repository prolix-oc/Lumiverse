import { useEffect, useState } from 'react'
import { dreamWeaverApi, type DreamWeaverVisualJob } from '@/api/dream-weaver'
import { EventType } from '@/types/ws-events'
import { wsClient } from '@/ws/client'

export interface DreamWeaverVisualJobState {
  job: DreamWeaverVisualJob | null
  loading: boolean
  error: string | null
}

const DEFAULT_STATE: DreamWeaverVisualJobState = {
  job: null,
  loading: false,
  error: null,
}

function isTerminal(job: DreamWeaverVisualJob | null): boolean {
  return job?.status === 'completed' || job?.status === 'failed'
}

export function useDreamWeaverVisualJob(
  jobId: string | null | undefined,
  enabled = true,
): DreamWeaverVisualJobState {
  const [state, setState] = useState<DreamWeaverVisualJobState>(DEFAULT_STATE)

  useEffect(() => {
    if (!jobId || !enabled) {
      setState(DEFAULT_STATE)
      return
    }

    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const poll = async () => {
      try {
        const job = await dreamWeaverApi.getVisualJob(jobId)
        if (cancelled) return
        setState({ job, loading: false, error: null })
        if (isTerminal(job)) {
          stopPolling()
        }
      } catch (error: any) {
        if (cancelled) return
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error?.message ?? 'Failed to load visual job',
        }))
      }
    }

    const ensurePolling = () => {
      if (pollTimer || wsClient.connected) return
      pollTimer = setInterval(() => {
        void poll()
      }, 2000)
    }

    const handleUpdate = (job: DreamWeaverVisualJob) => {
      if (job.id !== jobId || cancelled) return
      setState({ job, loading: false, error: null })
      if (isTerminal(job)) {
        stopPolling()
      }
    }

    setState((prev) => ({ ...prev, loading: true, error: null }))
    void poll().finally(ensurePolling)

    const unsubs = [
      wsClient.on(EventType.CONNECTED, () => {
        stopPolling()
        void poll()
      }),
      wsClient.on(EventType.DREAM_WEAVER_VISUAL_JOB_CREATED, handleUpdate),
      wsClient.on(EventType.DREAM_WEAVER_VISUAL_JOB_PROGRESS, handleUpdate),
      wsClient.on(EventType.DREAM_WEAVER_VISUAL_JOB_COMPLETED, handleUpdate),
      wsClient.on(EventType.DREAM_WEAVER_VISUAL_JOB_FAILED, handleUpdate),
    ]

    ensurePolling()

    return () => {
      cancelled = true
      stopPolling()
      unsubs.forEach((unsub) => unsub())
    }
  }, [enabled, jobId])

  return state
}
