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
 *   5. Use the buffered synth path in parallel by default; for stream-enabled
 *      connections, synthesize sequentially so multi-chunk responses (Qwen
 *      WAV shards) can still play and persist in the correct order.
 */

import { useStore } from '@/store'
import { ttsApi } from '@/api/tts'
import { audioApi } from '@/api/audio'
import { markFreshlyAttached } from '@/lib/ttsPersistence'
import { sanitizeForTts, parseSegments, type TextSegment } from '@/lib/speechDetection'
import { synthesizeTtsSegments, shouldUseStreamingEndpoint, type SynthesizedTtsSegment } from '@/lib/ttsSynthesis'
import {
  resolveMessageSpeaker,
  resolveSegmentVoice,
  voiceCoalesceKey,
  type ResolvedSpeaker,
} from '@/lib/voiceResolution'
import { getActiveMessageId, speak, speakSegments, stop, setTTSVolume, setTTSSpeed, unlockTTSAudio } from '@/lib/ttsAudio'
import type { TtsConnectionProfile, VoiceRef } from '@/types/api'

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
  /**
   * When true, persist the synthesized audio even if the message already has
   * a saved audio attachment (the backend replaces it). Used by the
   * "Regenerate" flow after the user confirms in the modal. Default false
   * keeps auto-save from silently overwriting a saved recording.
   */
  replaceExistingAudio?: boolean
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

  const usesStreamingTransport = plan.some((item) =>
    shouldUseStreamingEndpoint(resolveTtsConnectionProfile(item.voice.connectionId)),
  )
  const chatId = state.activeChatId
  const targetSwipeId = readMessageSwipeId(args.messageId)
  if (usesStreamingTransport) {
    startStreamingPlayback({
      chatId,
      messageId: args.messageId,
      swipeId: targetSwipeId,
      plan,
      ttsSpeed: voiceSettings.ttsSpeed,
      replaceExistingAudio: !!args.replaceExistingAudio,
    })
    return true
  }

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

  // Parallel record of (buffer, mime) per slot so we can upload the same
  // bytes the audio engine just played. Indexed by slot so out-of-order
  // resolution doesn't shuffle the playback order on persist.
  const persistBuffers: Array<{ data: ArrayBuffer; mime: string } | null> = new Array(plan.length).fill(null)

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
        const mime = response.headers.get('content-type') || 'audio/mpeg'
        const buffer = await response.arrayBuffer()
        // Clone the buffer for persistence — the audio engine decodes the
        // original via AudioContext, which can detach the underlying memory
        // on some engines and leave the persist payload empty.
        persistBuffers[idx] = { data: buffer.slice(0), mime }
        resolvers[idx](buffer)
      } catch (err) {
        console.error('[TTS Playback] Segment synth threw:', err)
        resolvers[idx](null)
      }
    }
  }

  for (let i = 0; i < concurrency; i++) void runOne()

  // Capture chat id + the target swipe at the moment playback starts. If
  // the user switches chats or swipes to a different variant while the
  // upload is in flight, we still attach to the original message + swipe
  // — the audio belongs to the content that was just spoken, not whatever
  // is now active.
  void persistAfterPlayback({
    chatId,
    messageId: args.messageId,
    swipeId: targetSwipeId,
    slots,
    persistBuffers,
    replaceExistingAudio: !!args.replaceExistingAudio,
  })

  return true
}

/**
 * Read the current swipe_id for a message from the store. Used by both
 * synth flows to capture the target swipe at synth start, before any
 * user swiping can race the save round-trip. Returns undefined when the
 * message isn't in the store (e.g. it was deleted between trigger and
 * read) — the save endpoint falls back to the message's then-current
 * swipe_id in that case.
 */
function readMessageSwipeId(messageId: string): number | undefined {
  const msg = useStore.getState().messages.find((m) => m.id === messageId)
  return msg?.swipe_id
}

function resolveTtsConnectionProfile(connectionId: string): TtsConnectionProfile | null {
  return useStore.getState().ttsProfiles.find((profile) => profile.id === connectionId) || null
}

async function saveSegmentsToMessage(args: {
  chatId: string | null
  messageId: string
  swipeId: number | undefined
  segments: SynthesizedTtsSegment[]
  replaceExistingAudio: boolean
  autoPlayFreshMarker: boolean
  signal?: AbortSignal
}): Promise<boolean> {
  if (!args.chatId || args.segments.length === 0) return false

  if (!args.replaceExistingAudio) {
    const liveMessage = useStore.getState().messages.find((m) => m.id === args.messageId)
    const existingAttachments = Array.isArray((liveMessage?.extra as any)?.attachments)
      ? (liveMessage!.extra as any).attachments
      : []
    const alreadySaved = existingAttachments.some((a: any) =>
      a && a.type === 'audio' && (
        a.swipe_id === args.swipeId || a.swipe_id === undefined
      ),
    )
    if (alreadySaved) return false
  }

  const result = await audioApi.saveForMessage(
    args.chatId,
    args.messageId,
    args.segments,
    {
      signal: args.signal,
      swipeId: args.swipeId,
    },
  )
  if (!result?.message) return false

  markFreshlyAttached(args.messageId, { autoPlay: args.autoPlayFreshMarker })
  useStore.getState().updateMessage(args.messageId, result.message)
  return true
}

function startStreamingPlayback(args: {
  chatId: string | null
  messageId: string
  swipeId: number | undefined
  plan: PlanItem[]
  ttsSpeed: number
  replaceExistingAudio: boolean
}): void {
  let resolveHold: (value: ArrayBuffer | null) => void = () => {}
  const hold = new Promise<ArrayBuffer | null>((resolve) => {
    resolveHold = resolve
  })
  speakSegments([hold], args.messageId)

  void (async () => {
    const captured: SynthesizedTtsSegment[] = []
    let hadFailure = false
    let cancelled = false

    const playSegment = (segment: SynthesizedTtsSegment) => {
      if (getActiveMessageId() !== args.messageId) {
        cancelled = true
        return
      }
      speak(segment.data)
    }

    try {
      for (const item of args.plan) {
        if (getActiveMessageId() !== args.messageId) {
          cancelled = true
          break
        }

        try {
          const segments = await synthesizeTtsSegments(item.voice.connectionId, item.text, {
            profile: resolveTtsConnectionProfile(item.voice.connectionId),
            voice: item.voice.voice || undefined,
            speed: item.voice.parameters?.speed ?? args.ttsSpeed,
            onPlayableSegment: playSegment,
          })
          if (cancelled || getActiveMessageId() !== args.messageId) {
            cancelled = true
            break
          }
          captured.push(...segments)
        } catch (err) {
          hadFailure = true
          console.error('[TTS Playback] Segment synth threw:', err)
        }
      }
    } finally {
      resolveHold(null)
    }

    if (cancelled || hadFailure || captured.length === 0) return

    try {
      await saveSegmentsToMessage({
        chatId: args.chatId,
        messageId: args.messageId,
        swipeId: args.swipeId,
        segments: captured,
        replaceExistingAudio: args.replaceExistingAudio,
        autoPlayFreshMarker: false,
      })
    } catch (err) {
      console.warn('[TTS Playback] Failed to persist audio for message', args.messageId, err)
    }
  })()
}

/**
 * After every synth slot resolves, gather successful buffers in playback
 * order and POST them as one multipart upload. The server muxes the
 * segments into a single MP3 (ffmpeg when available, naive concat
 * fallback for MP3-only inputs) and attaches the result to the message.
 *
 * Skip persistence when:
 *   • The original chat id isn't known (defensive — TTS without an active
 *     chat shouldn't reach this code path, but guard anyway).
 *   • Any segment failed to synthesize. Persisting a partial recording would
 *     leave the user with a corrupted "saved" version and we'd never re-try.
 *   • The message already has a saved audio attachment. The save endpoint
 *     would overwrite it, but the user explicitly clicks "Regenerate" in
 *     that flow — the auto-save path should never silently replace.
 *   • No segments were captured (all nulls).
 *
 * Failures are logged and swallowed — playback already succeeded; not being
 * able to persist is a degradation, not an error worth toasting to the user.
 */
async function persistAfterPlayback(args: {
  chatId: string | null
  messageId: string
  /** The swipe the audio was synthesized for. May be undefined when the
   *  message couldn't be read from the store at synth start; the backend
   *  falls back to the message's current swipe_id in that case. */
  swipeId: number | undefined
  slots: Array<Promise<ArrayBuffer | null>>
  persistBuffers: Array<{ data: ArrayBuffer; mime: string } | null>
  replaceExistingAudio: boolean
}): Promise<void> {
  // Wait for all synth tasks to settle (resolved with buffer or null on failure).
  await Promise.all(args.slots)

  const captured = args.persistBuffers
  if (captured.some((c) => c === null)) {
    // Don't persist a partial recording — re-playing later would give the
    // user a silent gap mid-message with no way to recover.
    return
  }

  const segments = captured.filter((c): c is SynthesizedTtsSegment => c !== null)
  if (segments.length === 0) return

  try {
    await saveSegmentsToMessage({
      chatId: args.chatId,
      messageId: args.messageId,
      swipeId: args.swipeId,
      segments,
      replaceExistingAudio: args.replaceExistingAudio,
      autoPlayFreshMarker: false,
    })
  } catch (err) {
    console.warn('[TTS Playback] Failed to persist audio for message', args.messageId, err)
  }
}

/**
 * Auto-play pipeline that routes playback through the persistent audio
 * attachment rather than the in-memory engine.
 *
 * Order of operations:
 *   1. Plan + synthesize every segment in parallel (capped concurrency).
 *   2. Wait for all segments to settle. If any failed, fall back to in-memory
 *      playback so the user still hears the message — partial audio over
 *      silence is the right trade.
 *   3. Save all segments to the server (ffmpeg mux on the backend).
 *   4. Mark the message as freshly attached with autoPlay=true and push the
 *      updated message into the store. MessageAudioPlayer mounts, plays its
 *      load-in animation, and then auto-plays through the saved file.
 *   5. If saving fails, fall back to in-memory playback from the buffers we
 *      already have so the user isn't left silent on a network blip.
 *
 * Unlike `startMessageTtsPlayback`, this is asynchronous from the caller's
 * point of view — auto-play accepts the synth latency because the alternative
 * (in-memory plays now, persistent player appears later disconnected from the
 * audio) was the UX problem we were solving.
 */
export async function synthesizeSaveAndAutoPlay(args: {
  messageId: string
  messageName: string
  messageContent: string
  messageIsUser: boolean
  /**
   * Optional abort signal. When fired, in-flight synth + save fetches are
   * aborted, the result is discarded (no fresh marker, no store update,
   * no in-memory fallback), and the function returns false. Used by the
   * regen flow's "Cancel TTS generation" affordance.
   */
  signal?: AbortSignal
}): Promise<boolean> {
  const state = useStore.getState()
  const voiceSettings = state.voiceSettings
  if (!voiceSettings.ttsEnabled) return false

  const plan = planMessagePlayback({
    messageName: args.messageName,
    messageContent: args.messageContent,
    messageIsUser: args.messageIsUser,
  })
  if (plan.length === 0) return false

  const chatId = state.activeChatId
  if (!chatId) return false

  // Capture the target swipe at synth start so a mid-synth user swipe
  // doesn't misroute the recording. Falls back to undefined when the
  // message has gone (deleted between trigger and read); the backend
  // resolves to the message's then-current swipe_id in that case.
  const targetSwipeId = readMessageSwipeId(args.messageId)

  // Stop any in-flight in-memory playback (e.g. the user clicked play on an
  // older message right before generation finished) so playback ownership
  // unambiguously belongs to whatever the persistent player plays next.
  stop()
  unlockTTSAudio()
  setTTSVolume(voiceSettings.ttsVolume)
  setTTSSpeed(1.0)

  const persistBuffers: Array<SynthesizedTtsSegment[] | null> =
    new Array(plan.length).fill(null)

  let cursor = 0
  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor++
      if (idx >= plan.length) return
      if (args.signal?.aborted) return
      const item = plan[idx]
      try {
        persistBuffers[idx] = await synthesizeTtsSegments(item.voice.connectionId, item.text, {
          profile: resolveTtsConnectionProfile(item.voice.connectionId),
          voice: item.voice.voice || undefined,
          speed: item.voice.parameters?.speed ?? voiceSettings.ttsSpeed,
          signal: args.signal,
        })
      } catch (err) {
        // AbortError is expected when the user cancels — don't noise the
        // console for it.
        if ((err as any)?.name !== 'AbortError') {
          console.error('[TTS AutoPlay] Segment synth threw:', err)
        }
      }
    }
  }

  const concurrency = Math.min(MAX_CONCURRENT_SYNTH, plan.length)
  await Promise.all(Array.from({ length: concurrency }, () => runOne()))

  // Cancelled mid-synth → bail without persisting or falling back to in-memory.
  // The user explicitly asked us to stop, so don't start audio they no longer
  // want.
  if (args.signal?.aborted) return false

  // Partial failure → don't persist a corrupt file. Play whatever we got
  // through the in-memory engine so the user still hears audio.
  if (persistBuffers.some((b) => b === null)) {
    playInMemoryFromSegments(args.messageId, persistBuffers.flatMap((segments) => segments ?? []))
    return false
  }

  const segments = persistBuffers.flatMap((segmentList) => segmentList ?? [])

  try {
    const saved = await saveSegmentsToMessage({
      chatId,
      messageId: args.messageId,
      signal: args.signal,
      swipeId: targetSwipeId,
      segments,
      replaceExistingAudio: true,
      autoPlayFreshMarker: true,
    })
    if (args.signal?.aborted) return false
    if (saved) {
      return true
    }
    // Save returned no message (shouldn't happen) — fall through to in-memory.
    playInMemoryFromSegments(args.messageId, segments)
    return false
  } catch (err) {
    // Cancelled during the save round-trip — silent return, no fallback
    // playback (user wanted to stop).
    if ((err as any)?.name === 'AbortError' || args.signal?.aborted) return false
    console.warn(
      '[TTS AutoPlay] Save failed, falling back to in-memory playback:',
      err,
    )
    playInMemoryFromSegments(args.messageId, segments)
    return false
  }
}

/**
 * Hand pre-fetched buffers to the in-memory audio engine. Used as the
 * fallback when the save-first auto-play flow can't persist (synth failure
 * or network/server save error). The user still hears audio — they just
 * don't get the persistent attachment for replay.
 */
function playInMemoryFromSegments(
  messageId: string,
  segments: SynthesizedTtsSegment[],
): void {
  const slots: Array<Promise<ArrayBuffer | null>> = segments.map((segment) =>
    Promise.resolve(segment.data),
  )
  speakSegments(slots, messageId)
}
