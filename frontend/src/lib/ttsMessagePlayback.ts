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
import { sanitizeForTts, parseSegments, type TtsTextOptions } from '@/lib/speechDetection'
import { synthesizeTtsSegments, shouldUseStreamingEndpoint, type SynthesizedTtsSegment } from '@/lib/ttsSynthesis'
import {
  resolveMessageVoices,
  voiceCoalesceKey,
} from '@/lib/voiceResolution'
import { getPlaybackSession, speak, speakSegments, stop, stopAllTTSPlayback, subscribeTTSPlayback, setTTSVolume, setTTSSpeed, unlockTTSAudio } from '@/lib/ttsAudio'
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

function voiceTextOptions(voice: VoiceRef | null, profiles: TtsConnectionProfile[]): TtsTextOptions {
  const profile = profiles.find((candidate) => candidate.id === voice?.connectionId)
  return {
    fishModel: profile?.provider === 'fish_audio' ? profile.model.trim() || 's2.1-pro' : undefined,
    preserveAudioCues: !!profile && (
      profile.provider === 'google_tts'
      || profile.provider === 'google_vertex_tts'
      || (profile.provider === 'openrouter_tts' && /^google\/gemini-/i.test(profile.model))
    ),
  }
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
  const voices = resolveMessageVoices({
    message: { name: args.messageName, is_user: args.messageIsUser },
    characters: state.characters,
    groupMemberIds: state.isGroupChat ? state.groupCharacterIds : null,
    fallbackCharacterId: state.activeCharacterId,
    chatMetadata: state.activeChatMetadata,
    voiceSettings,
    ttsProfiles: state.ttsProfiles,
  })

  const speechOptions = voiceTextOptions(voices.speech, state.ttsProfiles)
  const narrationOptions = voiceTextOptions(voices.narration, state.ttsProfiles)
  const fishModels = [speechOptions.fishModel, narrationOptions.fishModel]
  const textOptions: TtsTextOptions = {
    preserveAudioCues: speechOptions.preserveAudioCues || narrationOptions.preserveAudioCues,
    fishModel: fishModels.includes('drama-3-preview') ? 'drama-3-preview' : fishModels.find((model) => model && model !== 's1') || fishModels.find(Boolean),
  }
  const cleaned = sanitizeForTts(args.messageContent, textOptions)
  if (!cleaned) return []
  const segments = parseSegments(cleaned, voiceSettings.speechDetectionRules, textOptions)

  // Resolve voice per segment, drop skips, coalesce adjacent same-voice
  // segments. The coalesce key includes connection, voice, and parameters — two narration
  // segments separated by a speech segment do NOT merge because the speech
  // resolves to a different voice and breaks the run.
  const resolved: PlanItem[] = []
  for (const seg of segments) {
    if (seg.action === 'skip') continue
    const voice = seg.action === 'narration' ? voices.narration : voices.speech
    if (!voice) continue
    const options = seg.action === 'narration' ? narrationOptions : speechOptions
    const text = sanitizeForTts(seg.text, { ...options, stripFishDirections: !!textOptions.fishModel })
    if (!text) continue
    const last = resolved[resolved.length - 1]
    if (last && voiceCoalesceKey(last.voice) === voiceCoalesceKey(voice)) {
      last.text += ' ' + text
    } else {
      resolved.push({ text, voice })
    }
  }

  return resolved
}

/**
 * Synthesize and play a single message. Stops any in-flight playback first so
 * the queue never stacks across messages. Playback continues asynchronously.
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
  const playback = startMessageTtsPlaybackSession(args)
  void playback?.synthesized.catch((error) => console.error('[TTS Playback] Synthesis failed:', error))
  return playback !== null
}

/** Cancellable message playback for callers that need synthesis failures and ownership. */
export function startMessageTtsPlaybackSession(
  args: Parameters<typeof startMessageTtsPlayback>[0],
  options?: { enabled: boolean },
): {
  synthesized: Promise<void>
  cancel(): void
} | null {
  const state = useStore.getState()
  const voiceSettings = state.voiceSettings
  // Chat callers inherit the chat toggle; explicit extension requests supply
  // their own enablement after the Spindle Media permission check.
  if (!(options?.enabled ?? voiceSettings.ttsEnabled)) return null

  const plan = planMessagePlayback({
    messageName: args.messageName,
    messageContent: args.messageContent,
    messageIsUser: args.messageIsUser,
  })
  if (plan.length === 0) return null

  if (args.preempt !== false) stopAllTTSPlayback()
  unlockTTSAudio()
  setTTSVolume(voiceSettings.ttsVolume)
  // Speed is delivered to the provider per segment via the synth call below
  // (voice overrides, Fish connection defaults, then global ttsSpeed). Force the
  // playback rate to 1.0 so we don't double-apply on top of provider-side
  // speed — and so any live-tune state the test slider left behind is wiped.
  setTTSSpeed(1.0)

  const usesStreamingTransport = plan.some((item) =>
    shouldUseStreamingEndpoint(resolveTtsConnectionProfile(item.voice.connectionId)),
  )
  const chatId = state.activeChatId
  const targetSwipeId = readMessageSwipeId(args.messageId)
  const controller = new AbortController()
  const signal = controller.signal
  const cancel = () => controller.abort()
  if (usesStreamingTransport) {
    const synthesized = startStreamingPlayback({
      chatId,
      messageId: args.messageId,
      swipeId: targetSwipeId,
      plan,
      ttsSpeed: voiceSettings.ttsSpeed,
      replaceExistingAudio: !!args.replaceExistingAudio,
      signal,
    })
    return { synthesized, cancel }
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
  let failure: unknown
  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor++
      if (idx >= plan.length) return
      if (signal.aborted) {
        resolvers[idx](null)
        continue
      }
      const item = plan[idx]
      try {
        const response = await ttsApi.synthesize(item.voice.connectionId, item.text, {
          ...voiceSynthesisOptions(item.voice, voiceSettings.ttsSpeed),
          signal,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(body.trim() || `TTS synthesis failed (${response.status})`)
        }
        const mime = response.headers.get('content-type') || 'audio/mpeg'
        const buffer = await response.arrayBuffer()
        // Clone the buffer for persistence — the audio engine decodes the
        // original via AudioContext, which can detach the underlying memory
        // on some engines and leave the persist payload empty.
        persistBuffers[idx] = { data: buffer.slice(0), mime }
        resolvers[idx](buffer)
      } catch (err) {
        if (!signal.aborted) failure ??= err
        resolvers[idx](null)
      }
    }
  }

  const synthesized = Promise.all(Array.from({ length: concurrency }, () => runOne())).then(() => {
    if (failure !== undefined) throw failure
  })

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
    signal,
  })

  return { synthesized, cancel }
}

/**
 * Speak caller text with one connection's default voice. Nothing is saved.
 * Stops in-flight playback first. Resolves once synthesis has finished (NOT
 * once playback finishes); rejects when synthesis fails.
 */
export async function startTextTtsPlayback(args: { text: string; connectionId: string; signal?: AbortSignal }): Promise<void> {
  const voiceSettings = useStore.getState().voiceSettings
  const profile = resolveTtsConnectionProfile(args.connectionId)
  stopAllTTSPlayback()
  unlockTTSAudio()
  setTTSVolume(voiceSettings.ttsVolume)
  setTTSSpeed(1.0)
  // Hold the session open until synthesis ends, as startStreamingPlayback does.
  let release!: () => void
  speakSegments([new Promise<null>((resolve) => { release = () => resolve(null) })])
  const owner = getPlaybackSession()
  try {
    await synthesizeTtsSegments(args.connectionId, args.text, {
      profile,
      ...voiceSynthesisOptions({ connectionId: args.connectionId, voice: profile?.voice ?? '' }, voiceSettings.ttsSpeed),
      signal: args.signal,
      onPlayableSegment: (segment) => {
        if (getPlaybackSession() === owner) speak(segment.data)
      },
    })
  } finally {
    release()
  }
}

/** Replay a message's saved audio attachment through the engine, as MessageAudioPlayer's fallback does. */
export function playSavedMessageAudio(messageId: string, audioId: string, signal?: AbortSignal): Promise<void> {
  stopAllTTSPlayback()
  unlockTTSAudio()
  setTTSVolume(useStore.getState().voiceSettings.ttsVolume)
  setTTSSpeed(1.0)
  const loaded = fetch(audioApi.url(audioId), { credentials: 'include', signal }).then((response) => {
    if (!response.ok) throw new Error(`TTS_AUDIO_LOAD_FAILED: ${response.status}`)
    return response.arrayBuffer()
  })
  speakSegments([loaded], messageId)
  return loaded.then(() => {})
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

function voiceSynthesisOptions(voice: VoiceRef, globalSpeed: number) {
  const profile = resolveTtsConnectionProfile(voice.connectionId)
  const configuredSpeed = profile?.provider === 'fish_audio' ? profile.default_parameters.speed : undefined
  return {
    voice: voice.voice || undefined,
    parameters: voice.parameters,
    speed: voice.parameters?.speed ?? (configuredSpeed != null ? Number(configuredSpeed) : globalSpeed),
  }
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
  if (!result?.message || args.signal?.aborted) return false

  markFreshlyAttached(args.messageId, { autoPlay: args.autoPlayFreshMarker, playbackSession: getPlaybackSession() })
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
  signal: AbortSignal
}): Promise<void> {
  let resolveHold: (value: ArrayBuffer | null) => void = () => {}
  const hold = new Promise<ArrayBuffer | null>((resolve) => {
    resolveHold = resolve
  })
  speakSegments([hold], args.messageId)
  const owner = getPlaybackSession()

  return (async () => {
    const captured: SynthesizedTtsSegment[] = []
    let failure: unknown
    let cancelled = false

    const playSegment = (segment: SynthesizedTtsSegment) => {
      if (args.signal.aborted || getPlaybackSession() !== owner) {
        cancelled = true
        return
      }
      speak(segment.data)
    }

    try {
      for (const item of args.plan) {
        if (args.signal.aborted || getPlaybackSession() !== owner) {
          cancelled = true
          break
        }

        try {
          const segments = await synthesizeTtsSegments(item.voice.connectionId, item.text, {
            profile: resolveTtsConnectionProfile(item.voice.connectionId),
            ...voiceSynthesisOptions(item.voice, args.ttsSpeed),
            signal: args.signal,
            onPlayableSegment: playSegment,
          })
          if (cancelled || args.signal.aborted || getPlaybackSession() !== owner) {
            cancelled = true
            break
          }
          captured.push(...segments)
        } catch (err) {
          if (!args.signal.aborted) failure ??= err
        }
      }
    } finally {
      resolveHold(null)
    }

    if (failure !== undefined) throw failure
    if (cancelled || args.signal.aborted || captured.length === 0) return

    void saveSegmentsToMessage({
      chatId: args.chatId,
      messageId: args.messageId,
      swipeId: args.swipeId,
      segments: captured,
      replaceExistingAudio: args.replaceExistingAudio,
      autoPlayFreshMarker: false,
      signal: args.signal,
    }).catch((err) => {
      console.warn('[TTS Playback] Failed to persist audio for message', args.messageId, err)
    })
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
  signal?: AbortSignal
}): Promise<void> {
  // Wait for all synth tasks to settle (resolved with buffer or null on failure).
  await Promise.all(args.slots)
  if (args.signal?.aborted) return

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
      signal: args.signal,
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

  const owner = getPlaybackSession()
  const controller = new AbortController()
  const signal = controller.signal
  const abort = () => controller.abort()
  args.signal?.addEventListener('abort', abort, { once: true })
  if (args.signal?.aborted) abort()
  const unsubscribe = subscribeTTSPlayback(() => {
    if (getPlaybackSession() !== owner) controller.abort()
  })
  try {
    const persistBuffers: Array<SynthesizedTtsSegment[] | null> =
      new Array(plan.length).fill(null)

    let cursor = 0
    const runOne = async (): Promise<void> => {
      while (true) {
        const idx = cursor++
        if (idx >= plan.length) return
        if (signal.aborted) return
        const item = plan[idx]
        try {
          persistBuffers[idx] = await synthesizeTtsSegments(item.voice.connectionId, item.text, {
            profile: resolveTtsConnectionProfile(item.voice.connectionId),
            ...voiceSynthesisOptions(item.voice, voiceSettings.ttsSpeed),
            signal,
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
    if (signal.aborted) return false

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
        signal,
        swipeId: targetSwipeId,
        segments,
        replaceExistingAudio: true,
        autoPlayFreshMarker: true,
      })
      if (signal.aborted) return false
      if (saved) {
        return true
      }
      // Save returned no message (shouldn't happen) — fall through to in-memory.
      playInMemoryFromSegments(args.messageId, segments)
      return false
    } catch (err) {
      // Cancelled during the save round-trip — silent return, no fallback
      // playback (user wanted to stop).
      if ((err as any)?.name === 'AbortError' || signal.aborted) return false
      console.warn(
        '[TTS AutoPlay] Save failed, falling back to in-memory playback:',
        err,
      )
      playInMemoryFromSegments(args.messageId, segments)
      return false
    }
  } finally {
    args.signal?.removeEventListener('abort', abort)
    unsubscribe()
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
