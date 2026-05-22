import { useCallback, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import {
  stop,
  getActiveMessageId,
  subscribeActiveMessage,
} from '@/lib/ttsAudio'
import { startMessageTtsPlayback } from '@/lib/ttsMessagePlayback'

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
 * audio and vice versa. Routes through the shared multi-voice pipeline so
 * narration and per-character voices play gaplessly in segment order.
 */
export function useMessagePlayback(
  messageId: string,
  content: string,
  name: string,
  isUser: boolean,
): UseMessagePlaybackResult {
  const ttsEnabled = useStore((s) => s.voiceSettings.ttsEnabled)
  const connectionId = useStore((s) => s.voiceSettings.ttsConnectionId)
  const isPlaying = useIsMessagePlaying(messageId)
  // canPlay is permissive — a character or chat-level override can supply a
  // voice even when no global default is configured. The actual decision
  // lives in the resolver; the button just stays enabled when TTS is on.
  const canPlay = Boolean(ttsEnabled && connectionId)

  const toggle = useCallback(async () => {
    if (isPlaying) {
      stop()
      return
    }
    startMessageTtsPlayback({
      messageId,
      messageName: name,
      messageContent: content,
      messageIsUser: isUser,
    })
  }, [isPlaying, content, messageId, name, isUser])

  return { canPlay, isPlaying, toggle }
}
