import { useEffect } from 'react'
import { useStore } from '@/store'
import { getSpokenText } from '@/lib/speechDetection'
import { speak, stop, setTTSVolume, setTTSSpeed, installTTSAudioPrimer } from '@/lib/ttsAudio'
import { ttsApi } from '@/api/tts'

/**
 * Kick off TTS auto-playback for a finished generation.
 *
 * Called directly from the WebSocket GENERATION_ENDED handler — the payload
 * already carries the final message id and content, so we don't have to wait
 * for message-list reconciliation or infer the target from store state.
 *
 * No-ops when TTS is disabled, no default connection is configured, the
 * auto-play toggle is off, or the content has no spoken segments after
 * speech-detection filtering.
 *
 * Fire-and-forget: errors are logged to the console so a bad TTS request
 * never disrupts the surrounding generation teardown.
 */
export function triggerTTSAutoPlay(messageId: string, content: string): void {
  const { voiceSettings } = useStore.getState()

  if (!voiceSettings.ttsEnabled || !voiceSettings.ttsAutoPlay || !voiceSettings.ttsConnectionId) {
    return
  }

  const text = getSpokenText(content, voiceSettings.speechDetectionRules)
  if (!text) return

  // Stop any currently-playing audio (e.g. the user's previous message still
  // reading out) before starting this generation's playback.
  stop()
  setTTSVolume(voiceSettings.ttsVolume)
  setTTSSpeed(voiceSettings.ttsSpeed)

  ttsApi
    .synthesize(voiceSettings.ttsConnectionId, text, { speed: voiceSettings.ttsSpeed })
    .then(async (response) => {
      if (!response.ok) {
        console.error('[TTS AutoPlay] Synthesis failed:', response.status, await response.text().catch(() => ''))
        return
      }
      const buffer = await response.arrayBuffer()
      speak(buffer, messageId)
    })
    .catch((err) => {
      console.error('[TTS AutoPlay] Synthesis failed:', err)
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
