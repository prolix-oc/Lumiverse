import { useEffect, useState } from 'react'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'

export type ImageGenPhase = 'idle' | 'generating' | 'finalizing'

export interface ImageGenProgressState {
  step: number
  totalSteps: number
  preview?: string
  nodeId?: string
  isGenerating: boolean
  /**
   * Lifecycle phase.
   * - 'generating': model is actively stepping (live preview frames stream in).
   * - 'finalizing': the model reported IMAGE_GEN_COMPLETE, but the HTTP request
   *   that returns the full-resolution image is still in flight. We retain the
   *   last preview frame during this window so the UI bridges the gap between
   *   the final preview frame and the final image instead of blanking out.
   */
  phase: ImageGenPhase
}

const DEFAULT_STATE: ImageGenProgressState = {
  step: 0,
  totalSteps: 0,
  preview: undefined,
  nodeId: undefined,
  isGenerating: false,
  phase: 'idle',
}

/**
 * Subscribes to WebSocket image generation progress events for a given assetId.
 * Returns the current progress state. On completion it transitions to the
 * 'finalizing' phase (keeping the last preview frame) rather than resetting, so
 * callers can keep showing something until the final image is ready; it resets
 * on error or when the assetId clears.
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
        // Comfy/Swarm interleave step-only events (no preview field) with
        // preview frames. Preserve the previous preview/nodeId so the <img>
        // element stays mounted between frames — otherwise it unmounts on
        // every step event and visibly bounces the surrounding layout.
        setState((prev) => ({
          step: typeof payload.step === 'number' ? payload.step : prev.step,
          totalSteps: typeof payload.totalSteps === 'number' ? payload.totalSteps : prev.totalSteps,
          preview: payload.preview ?? prev.preview,
          nodeId: payload.nodeId ?? prev.nodeId,
          isGenerating: true,
          phase: 'generating',
        }))
      }),

      wsClient.on(EventType.IMAGE_GEN_COMPLETE, (payload: { assetId: string }) => {
        if (payload.assetId !== assetId) return
        // The model is done, but the HTTP call that returns the full image is
        // still resolving (often ~seconds for Comfy/Swarm to encode it). Keep
        // the last preview frame and flip to 'finalizing' instead of wiping
        // state, so the panel can bridge the gap until it swaps in the final
        // image (which also unmounts this subscription).
        setState((prev) => ({ ...prev, isGenerating: false, phase: 'finalizing' }))
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
