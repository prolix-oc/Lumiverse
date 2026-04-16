import { useCallback, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { ttsApi } from '@/api/tts'
import {
  speak,
  stop,
  setTTSVolume,
  setTTSSpeed,
  getActiveMessageId,
  subscribeActiveMessage,
  unlockTTSAudio,
} from '@/lib/ttsAudio'
import { getSpokenText } from '@/lib/speechDetection'

/**
 * Subscribes to the shared TTS pipeline's "active message id" so a component
 * can flip between Play and Stop states without polling.
 */
export function useIsMessagePlaying(messageId: string): boolean {
  const activeId = useSyncExternalStore(
    subscribeActiveMessage,
    getActiveMessageId,
    () => null,
  )
  return activeId === messageId
}

export interface UseMessagePlaybackResult {
  /** True when TTS is configured enough to offer playback at all. */
  canPlay: boolean
  /** True when THIS message's audio is currently owning the TTS queue. */
  isPlaying: boolean
  /** Toggles: plays this message, or stops if it's already playing. */
  toggle: () => Promise<void>
}

/**
 * Per-message playback controller. Reuses the same singleton audio pipeline
 * as the auto-play hook so starting a manual playback cancels any in-flight
 * audio and vice versa.
 */
export function useMessagePlayback(messageId: string, content: string): UseMessagePlaybackResult {
  const ttsEnabled = useStore((s) => s.voiceSettings.ttsEnabled)
  const connectionId = useStore((s) => s.voiceSettings.ttsConnectionId)
  const isPlaying = useIsMessagePlaying(messageId)
  const canPlay = Boolean(ttsEnabled && connectionId)

  const toggle = useCallback(async () => {
    if (isPlaying) {
      stop()
      return
    }
    const { voiceSettings } = useStore.getState()
    if (!voiceSettings.ttsEnabled || !voiceSettings.ttsConnectionId) return

    const text = getSpokenText(content, voiceSettings.speechDetectionRules)
    if (!text) return

    // Stop any in-flight playback (auto-play for another message, etc.) before
    // starting this one so the queue doesn't stack.
    stop()
    unlockTTSAudio()
    setTTSVolume(voiceSettings.ttsVolume)
    setTTSSpeed(voiceSettings.ttsSpeed)

    try {
      const response = await ttsApi.synthesize(voiceSettings.ttsConnectionId, text, {
        speed: voiceSettings.ttsSpeed,
      })
      if (!response.ok) {
        console.error('[TTS Playback] Synthesis failed:', response.status, await response.text().catch(() => ''))
        return
      }
      const buffer = await response.arrayBuffer()
      speak(buffer, messageId)
    } catch (err) {
      console.error('[TTS Playback] Synthesis failed:', err)
    }
  }, [isPlaying, content, messageId])

  return { canPlay, isPlaying, toggle }
}
