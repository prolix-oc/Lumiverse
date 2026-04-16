import { useEffect, useState } from 'react'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'

export interface ImageGenProgressState {
  step: number
  totalSteps: number
  preview?: string
  nodeId?: string
  isGenerating: boolean
}

const DEFAULT_STATE: ImageGenProgressState = {
  step: 0,
  totalSteps: 0,
  preview: undefined,
  nodeId: undefined,
  isGenerating: false,
}

/**
 * Subscribes to WebSocket image generation progress events for a given assetId.
 * Returns the current progress state, automatically resetting on completion or error.
 */
export function useImageGenProgress(assetId: string | null | undefined): ImageGenProgressState {
  const [state, setState] = useState<ImageGenProgressState>(DEFAULT_STATE)

  useEffect(() => {
    if (!assetId) {
      setState(DEFAULT_STATE)
      return
    }

    const unsubs = [
      wsClient.on(EventType.IMAGE_GEN_PROGRESS, (payload: { assetId: string; step: number; totalSteps: number; preview?: string; nodeId?: string }) => {
        if (payload.assetId !== assetId) return
        setState({
          step: payload.step,
          totalSteps: payload.totalSteps,
          preview: payload.preview,
          nodeId: payload.nodeId,
          isGenerating: true,
        })
      }),

      wsClient.on(EventType.IMAGE_GEN_COMPLETE, (payload: { assetId: string }) => {
        if (payload.assetId !== assetId) return
        setState(DEFAULT_STATE)
      }),

      wsClient.on(EventType.IMAGE_GEN_ERROR, (payload: { assetId: string }) => {
        if (payload.assetId !== assetId) return
        setState(DEFAULT_STATE)
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [assetId])

  return state
}
