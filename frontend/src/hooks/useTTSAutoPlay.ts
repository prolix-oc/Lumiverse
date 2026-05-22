import { useEffect } from 'react'
import { useStore } from '@/store'
import { installTTSAudioPrimer } from '@/lib/ttsAudio'
import { startMessageTtsPlayback } from '@/lib/ttsMessagePlayback'

/**
 * Kick off TTS auto-playback for a finished generation.
 *
 * Called directly from the WebSocket GENERATION_ENDED handler — the payload
 * already carries the final message id and content, so we don't have to wait
 * for message-list reconciliation or infer the target from store state.
 *
 * No-ops when TTS is disabled, auto-play is off, or the content has no
 * spoken segments after speech-detection filtering. Routes through the
 * shared multi-voice pipeline so narrator + per-character voices play
 * gaplessly when configured.
 *
 * Fire-and-forget: errors are logged so a bad TTS request never disrupts
 * the surrounding generation teardown.
 */
export function triggerTTSAutoPlay(args: {
  messageId: string
  content: string
  name: string
  isUser: boolean
}): void {
  const { voiceSettings } = useStore.getState()
  if (!voiceSettings.ttsEnabled || !voiceSettings.ttsAutoPlay) return

  startMessageTtsPlayback({
    messageId: args.messageId,
    messageName: args.name,
    messageContent: args.content,
    messageIsUser: args.isUser,
  })
}

/**
 * App-level mount that primes the AudioContext on first user gesture so
 * generation-triggered TTS playback isn't blocked by browser autoplay policy.
 *
 * The actual playback trigger lives in `triggerTTSAutoPlay`, called directly
 * from the WebSocket handler on GENERATION_ENDED — that path has the final
 * message id + content in hand, so there's no race with message-list
 * reconciliation or streaming→idle store transitions.
 */
export function useTTSAutoPlay() {
  useEffect(() => installTTSAudioPrimer(), [])
}
