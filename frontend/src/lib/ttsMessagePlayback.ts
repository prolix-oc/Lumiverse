/**
 * Shared TTS pipeline used by both the per-message Play button
 * (useMessagePlayback) and the auto-play hook (useTTSAutoPlay).
 *
 * Responsibilities:
 *   1. Parse the message into ordered speech/narration segments.
 *   2. Resolve the speaker (handles group-chat name → character_id lookup).
 *   3. Resolve a voice for each segment via the documented fallback chain
 *      (chat override → character default → global default).
 *   4. Coalesce adjacent same-voice segments into one TTS request to cut
 *      latency and avoid micro-joins on the audio clock.
 *   5. Fire synthesize() requests in parallel (capped concurrency) and hand
 *      the resulting promises to `speakSegments`, which preserves order and
 *      schedules each buffer gaplessly.
 */

import { useStore } from '@/store'
import { ttsApi } from '@/api/tts'
import { sanitizeForTts, parseSegments, type TextSegment } from '@/lib/speechDetection'
import {
  resolveMessageSpeaker,
  resolveSegmentVoice,
  voiceCoalesceKey,
  type ResolvedSpeaker,
} from '@/lib/voiceResolution'
import { speakSegments, stop, setTTSVolume, setTTSSpeed, unlockTTSAudio } from '@/lib/ttsAudio'
import type { VoiceRef } from '@/types/api'

/**
 * Max number of TTS requests in flight at once. Keeps modest pressure on the
 * provider while still pipelining decode against synthesis. Higher would
 * marginally reduce time-to-first-buffer but stresses cheap providers and
 * rate-limited APIs.
 */
const MAX_CONCURRENT_SYNTH = 3

interface PlanItem {
  text: string
  voice: VoiceRef
}

/**
 * Plan the coalesced TTS requests for a message. Returns an empty array when
 * there's nothing to speak. Exported for tests / preview UIs.
 */
export function planMessagePlayback(args: {
  messageName: string
  messageContent: string
  messageIsUser: boolean
}): PlanItem[] {
  const state = useStore.getState()
  const voiceSettings = state.voiceSettings
  const characters = state.characters
  const groupMemberIds = state.isGroupChat ? state.groupCharacterIds : null
  const fallbackCharacterId = state.activeCharacterId
  const chatMetadata = state.activeChatMetadata

  // Resolve speaker once per message — speaker doesn't change mid-content.
  const speaker: ResolvedSpeaker = resolveMessageSpeaker({
    message: { name: args.messageName, is_user: args.messageIsUser },
    characters,
    groupMemberIds,
    fallbackCharacterId,
  })

  const character = speaker.characterId
    ? characters.find((c) => c.id === speaker.characterId) ?? null
    : null

  const cleaned = sanitizeForTts(args.messageContent)
  if (!cleaned) return []
  const segments = parseSegments(cleaned, voiceSettings.speechDetectionRules)

  // Resolve voice per segment, drop skips, coalesce adjacent same-voice
  // segments. The coalesce key is connection|voice|speed — two narration
  // segments separated by a speech segment do NOT merge because the speech
  // resolves to a different voice and breaks the run.
  const resolved: PlanItem[] = []
  for (const seg of segments) {
    const { voice, action } = resolveSegmentVoice({
      segment: seg as TextSegment,
      speaker,
      character,
      chatMetadata,
      voiceSettings,
    })
    if (action === 'skip' || !voice) continue
    const last = resolved[resolved.length - 1]
    if (last && voiceCoalesceKey(last.voice) === voiceCoalesceKey(voice)) {
      last.text += ' ' + seg.text
    } else {
      resolved.push({ text: seg.text, voice })
    }
  }

  return resolved
}

/**
 * Synthesize and play a single message. Stops any in-flight playback first so
 * the queue never stacks across messages. The returned Promise resolves once
 * the last synth request has been issued (NOT once playback finishes —
 * callers that want end-of-playback should subscribe to ttsAudio events).
 *
 * Returns `false` when there's nothing playable (no segments, no voice
 * configured, etc.) so callers can fall back to a "nothing to play" UI.
 */
export function startMessageTtsPlayback(args: {
  messageId: string
  messageName: string
  messageContent: string
  messageIsUser: boolean
  /** Stop in-flight playback before starting. Defaults to true. */
  preempt?: boolean
}): boolean {
  const state = useStore.getState()
  const voiceSettings = state.voiceSettings
  if (!voiceSettings.ttsEnabled) return false

  const plan = planMessagePlayback({
    messageName: args.messageName,
    messageContent: args.messageContent,
    messageIsUser: args.messageIsUser,
  })
  if (plan.length === 0) return false

  if (args.preempt !== false) stop()
  unlockTTSAudio()
  setTTSVolume(voiceSettings.ttsVolume)
  // Speed is delivered to the provider per segment via the synth call below
  // (voice.parameters.speed, falling back to the global ttsSpeed). Force the
  // playback rate to 1.0 so we don't double-apply on top of provider-side
  // speed — and so any live-tune state the test slider left behind is wiped.
  setTTSSpeed(1.0)

  const concurrency = Math.min(MAX_CONCURRENT_SYNTH, plan.length)
  const slots: Array<Promise<ArrayBuffer | null>> = new Array(plan.length)
  // Each slot is a deferred — its promise is what `speakSegments` will await,
  // its resolve() is what the runner fires once the synth call returns.
  const resolvers: Array<(value: ArrayBuffer | null) => void> = []
  for (let i = 0; i < plan.length; i++) {
    slots[i] = new Promise<ArrayBuffer | null>((resolve) => {
      resolvers.push(resolve)
    })
  }

  // Hand the promises to the audio engine BEFORE kicking synthesis so the
  // order map is established before any slot can resolve.
  speakSegments(slots, args.messageId)

  // Run synth tasks with bounded concurrency. We use a simple cursor-based
  // worker pool — N workers pull the next index, fetch + handoff, repeat.
  let cursor = 0
  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor++
      if (idx >= plan.length) return
      const item = plan[idx]
      try {
        const response = await ttsApi.synthesize(item.voice.connectionId, item.text, {
          voice: item.voice.voice || undefined,
          speed: item.voice.parameters?.speed ?? voiceSettings.ttsSpeed,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          console.error('[TTS Playback] Segment synth failed:', response.status, body)
          resolvers[idx](null)
          continue
        }
        const buffer = await response.arrayBuffer()
        resolvers[idx](buffer)
      } catch (err) {
        console.error('[TTS Playback] Segment synth threw:', err)
        resolvers[idx](null)
      }
    }
  }

  for (let i = 0; i < concurrency; i++) void runOne()

  return true
}
