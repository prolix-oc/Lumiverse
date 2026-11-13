import { useEffect } from 'react'
import { useStore } from '@/store'
import { installTTSAudioPrimer } from '@/lib/ttsAudio'
import { synthesizeSaveAndAutoPlay } from '@/lib/ttsMessagePlayback'

/**
 * Kick off TTS auto-playback for a finished generation.
 *
 * Called directly from the WebSocket GENERATION_ENDED handler — the payload
 * already carries the final message id and content, so we don't have to wait
 * for message-list reconciliation or infer the target from store state.
 *
 * No-ops when TTS is disabled, auto-play is off, or the content has no
 * spoken segments after speech-detection filtering.
 *
 * Routes through `synthesizeSaveAndAutoPlay` rather than the in-memory-first
 * `startMessageTtsPlayback`: we synthesize all segments, save the muxed file
 * to the server, then let the freshly-mounted MessageAudioPlayer animate in
 * and start playback through the persistent attachment. This costs a few
 * extra seconds before audio starts but makes the persistent player the
 * actual playback source (rather than an inert "saved version" sitting
 * disconnected next to whatever the in-memory engine just played).
 *
 * Fire-and-forget: errors inside the pipeline fall back to in-memory
 * playback so the user always hears the message even if save fails.
 */
export function triggerTTSAutoPlay(args: {
  messageId: string
  content: string
  name: string
  isUser: boolean
}): void {
  const { voiceSettings } = useStore.getState()
  if (!voiceSettings.ttsEnabled || !voiceSettings.ttsAutoPlay) return

  void synthesizeSaveAndAutoPlay({
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
