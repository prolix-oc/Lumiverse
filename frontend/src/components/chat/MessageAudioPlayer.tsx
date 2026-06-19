import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { Loader2, Play, Pause, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  consumeFreshMarker,
  isRegenerating,
  subscribeRegenerating,
} from '@/lib/ttsPersistence'
import {
  speak,
  stop as stopTTSEngine,
  getActiveMessageId,
  subscribeActiveMessage,
} from '@/lib/ttsAudio'
import styles from './MessageAudioPlayer.module.css'
import clsx from 'clsx'

interface MessageAudioPlayerProps {
  /** URL of the audio file. Bound directly to <audio src>. */
  src: string
  /** Optional label rendered as a tooltip on the player root. */
  title?: string
  /** Tagged onto the root so chat-bubble layout can flip alignment. */
  isUser?: boolean
  /**
   * The id of the message this player is attached to. Used to consume any
   * fresh-attachment marker the TTS pipeline left for us — if present, the
   * player runs its load-in animation and (when the marker carries
   * autoPlay=true) starts playback after the animation finishes.
   */
  messageId?: string
  /**
   * When flipped to true, the player pauses playback and runs its load-in
   * animation in reverse (height 1fr → 0fr, opacity 1 → 0). Once the
   * animation finishes, onExited fires so the parent can actually drop the
   * player from the tree. Used by MessageAudioPresence to animate audio
   * attachments out instead of letting them pop, which is the layout-shift
   * source the chat virtualizer was translating into visible scroll jumps.
   */
  exiting?: boolean
  /** Called once the exit animation completes. No-op if exiting is false. */
  onExited?: () => void
  /**
   * Optional delete affordance. When provided, the player renders a tiny
   * trash icon at the trailing edge that fires this callback on click.
   * The parent owns the actual deletion + any confirmation flow — the
   * player just surfaces the button. Omit to hide the delete control
   * (e.g. read-only message views).
   */
  onDelete?: () => void
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Minimal custom audio player for TTS attachments. Uses one HTMLAudioElement
 * under the hood — no Web Audio decoding, no segment scheduling — because
 * the file is already a single muxed MP3. Both the seek and volume sliders
 * are native <input type="range"> so keyboard, screen-reader, and touch
 * support come for free; the visual styling (thin track, fill that splits
 * at the current value) is painted via CSS on the standard pseudo-elements.
 */
export default function MessageAudioPlayer({
  src,
  title,
  isUser,
  messageId,
  exiting = false,
  onExited,
  onDelete,
}: MessageAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const volumePopoverRef = useRef<HTMLDivElement | null>(null)
  const volumeButtonRef = useRef<HTMLButtonElement | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  // Mount-time consumption of the fresh-attachment marker. We use a lazy
  // initializer so the consume() side effect only fires once across React's
  // potential double-invocation in Strict Mode. Once consumed, the marker
  // can't fire again even if the player remounts (e.g. user scrolled out
  // and back) — that's the right behavior, the load-in animation belongs
  // to the moment the audio first attached, not to every render.
  const [freshMarker] = useState(() =>
    messageId ? consumeFreshMarker(messageId) : null,
  )
  const isFresh = !!freshMarker
  // The wrapper element holds the load-in animation classes. We strip the
  // freshly-attached class after the animation ends so it doesn't replay
  // when the parent re-renders for other reasons.
  const [animationDone, setAnimationDone] = useState(!isFresh)
  const shouldAutoPlay = !!freshMarker?.autoPlay

  const volumePopoverOpenedAt = useRef(0)

  // Track whether this src change is the very first one (mount) so the
  // src-change useEffect doesn't double-trigger autoplay alongside the
  // mount-time fresh-marker consumption.
  const isFirstSrcRef = useRef(true)

  // ── Regenerating observation ────────────────────────────────────────────
  // Subscribe to the regenerating registry so the player can pause + show
  // an overlay while a save-first regen is in flight for this message.
  // The player stays mounted throughout — that's the whole point of using
  // a flag instead of optimistically stripping the attachment from the
  // store (which would unmount the player and cause the layout shift the
  // chat virtualizer turns into a visible scroll jump).
  const regenerating = useSyncExternalStore(
    subscribeRegenerating,
    () => (messageId ? isRegenerating(messageId) : false),
    () => false,
  )

  // ── Engine playback observation ─────────────────────────────────────────
  // True while the shared Web Audio engine is speaking THIS message — either
  // the autoplay-policy fallback below or a pipeline fallback (e.g. save
  // failure during regen). The play button doubles as Stop in that state so
  // the widget never looks idle while its audio is audibly playing.
  const enginePlaying = useSyncExternalStore(
    subscribeActiveMessage,
    () => (messageId ? getActiveMessageId() === messageId : false),
    () => false,
  )

  // Autoplay fallback: HTMLAudioElement.play() without a recent user gesture
  // is rejected by autoplay policy in some browsers (Safari/iOS always by
  // default, Chrome in hidden tabs) — and by the time a generation + synth
  // round-trip finishes, the send gesture is long expired. The Web Audio
  // engine doesn't have that problem: its AudioContext is unlocked once by
  // the app-level primer and stays unlocked, which is exactly how pre-widget
  // auto-play worked. Fetch the saved file and route it through the engine
  // so the user still hears the message; `enginePlaying` keeps the button
  // state coherent.
  const playViaEngineFallback = useCallback(() => {
    if (!messageId) return
    fetch(src, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`)
        return res.arrayBuffer()
      })
      .then((buffer) => {
        speak(buffer, messageId)
      })
      .catch((err) => {
        console.warn('[MessageAudioPlayer] engine fallback failed:', err)
      })
  }, [src, messageId])

  // ── HTMLAudioElement event wiring ───────────────────────────────────────
  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const onLoaded = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0)
    const onTime = () => setCurrentTime(el.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    const onVolume = () => {
      setVolume(el.volume)
      setMuted(el.muted)
    }

    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('durationchange', onLoaded)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('playing', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('volumechange', onVolume)

    return () => {
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('durationchange', onLoaded)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('playing', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('volumechange', onVolume)
    }
  }, [])

  // Reset state when the src changes (e.g. user regenerated the TTS).
  // Also consume any fresh-attachment marker on src change so a regen that
  // swaps audio A → B can auto-play through the same (still-mounted)
  // player. The first-src guard skips this on mount because mount-time
  // autoplay is already wired through the load-in animation's
  // onAnimationEnd handler — without the guard, both paths would fire
  // play() and the second call would be a no-op but the first would skip
  // the animation wait.
  useEffect(() => {
    setCurrentTime(0)
    setIsPlaying(false)

    if (isFirstSrcRef.current) {
      isFirstSrcRef.current = false
      return
    }
    if (!messageId) return
    const marker = consumeFreshMarker(messageId)
    if (!marker?.autoPlay) return
    // The audio element's src is React-bound, so by the time this effect
    // runs the new URL is already on the element. play() awaits whatever
    // loading is needed before it can actually start.
    const el = audioRef.current
    if (!el) return
    void el.play().catch((err) => {
      console.warn('[MessageAudioPlayer] autoplay-on-src-change rejected:', err)
      if ((err as any)?.name === 'NotAllowedError') playViaEngineFallback()
    })
  }, [src, messageId, playViaEngineFallback])

  // Pause whenever we enter the regenerating state. The audio attachment
  // hasn't actually changed yet at this point (the backend save hasn't
  // returned), but the user has explicitly asked to regenerate so we
  // shouldn't keep streaming the about-to-be-replaced file.
  useEffect(() => {
    if (!regenerating) return
    const el = audioRef.current
    if (el && !el.paused) el.pause()
  }, [regenerating])

  // ── Volume popover outside-close (Android-safe) ─────────────────────────
  useEffect(() => {
    if (!volumeOpen) return
    const onPointer = (e: PointerEvent) => {
      // 100ms guard so the click that opened the popover doesn't immediately
      // close it via the same event chain. Matches the codebase convention
      // documented in CLAUDE.md for popovers/dropdowns.
      if (Date.now() - volumePopoverOpenedAt.current < 100) return
      const target = e.target as Node | null
      if (!target) return
      if (volumePopoverRef.current?.contains(target)) return
      if (volumeButtonRef.current?.contains(target)) return
      setVolumeOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [volumeOpen])

  // ── Actions ─────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    // Engine owns playback (autoplay-policy fallback or pipeline fallback)
    // → the button acts as Stop for it.
    if (messageId && getActiveMessageId() === messageId) {
      stopTTSEngine()
      return
    }
    const el = audioRef.current
    if (!el) return
    if (el.paused || el.ended) {
      // Preempt any engine playback (including other messages') so widget
      // and engine audio never overlap.
      stopTTSEngine()
      void el.play().catch((err) => {
        console.warn('[MessageAudioPlayer] play() rejected:', err)
      })
    } else {
      el.pause()
    }
  }, [messageId])

  const toggleMute = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    el.muted = !el.muted
  }, [])

  const openVolume = useCallback(() => {
    volumePopoverOpenedAt.current = Date.now()
    setVolumeOpen((v) => !v)
  }, [])

  // ── Seek + volume input handlers ────────────────────────────────────────
  // Native <input type="range"> fires onChange on every value change
  // (drag, click-to-jump, keyboard arrows). We seek the audio element on
  // every change and update local state so the slider's filled-portion
  // gradient (--progress CSS var) stays in sync without lag.
  const onSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current
    if (!el) return
    const next = Number(e.target.value)
    if (!Number.isFinite(next)) return
    el.currentTime = next
    setCurrentTime(next)
  }, [])

  const onVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current
    if (!el) return
    const next = Math.max(0, Math.min(1, Number(e.target.value)))
    if (!Number.isFinite(next)) return
    el.volume = next
    // Nudging volume above 0 implicitly unmutes — matches the platform
    // convention of every other media player. The volumechange listener
    // syncs the React state for the icon.
    if (next > 0 && el.muted) el.muted = false
  }, [])

  // Display values for the slider fill. The seek slider needs a non-zero
  // max while duration is still loading (otherwise the input is rendered
  // disabled by some browsers), so we clamp to 1 before metadata lands.
  const seekMax = duration > 0 ? duration : 1
  const seekProgressPct = useMemo(() => {
    if (duration <= 0) return 0
    return Math.max(0, Math.min(100, (currentTime / duration) * 100))
  }, [currentTime, duration])

  const displayVolume = muted ? 0 : volume
  const volumeProgressPct = displayVolume * 100

  // Pause playback as soon as the parent flags us as exiting — don't keep
  // audio coming out of a shrinking element. Effect (not callback) so that
  // a transition exiting=false→true triggers the pause regardless of which
  // render the prop change arrives in.
  useEffect(() => {
    if (!exiting) return
    const el = audioRef.current
    if (el && !el.paused) el.pause()
    // If the engine fallback is speaking this message's audio, stop it too —
    // the attachment is going away, ghost audio shouldn't outlive it.
    if (messageId && getActiveMessageId() === messageId) stopTTSEngine()
  }, [exiting, messageId])

  // ── Wrapper animation lifecycle ─────────────────────────────────────────
  // Two animations can run on the wrapper: load-in (.wrapperFresh) and
  // exit (.wrapperExiting). Both end via this single handler — we
  // disambiguate by checking which class is active. The exit handler
  // notifies the parent so it can finally drop us from the tree; the
  // load-in handler clears the .fresh class and (when the fresh marker
  // requested it) kicks off playback. We wait until the load-in finishes
  // before starting audio so playback isn't disconnected from the
  // arrival animation.
  const onWrapperAnimationEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    // animationend bubbles — only react to the wrapper's own load-in/exit
    // animations, not child animations (custom CSS themes can animate
    // anything inside the bubble, which would otherwise end the load-in
    // early or fire a spurious onExited).
    if (e.target !== e.currentTarget) return
    if (exiting) {
      onExited?.()
      return
    }
    if (animationDone) return
    setAnimationDone(true)
    if (!shouldAutoPlay) return
    const el = audioRef.current
    if (!el) return
    void el.play().catch((err) => {
      // Browser autoplay policy blocks unmuted HTMLAudioElement playback
      // without a recent user gesture (Safari/iOS by default, Chrome in
      // hidden tabs) — and the send gesture has long expired by the time
      // generation + synthesis complete. Route the audio through the
      // gesture-primed Web Audio engine instead so auto-play still sounds.
      console.warn('[MessageAudioPlayer] autoplay rejected:', err)
      if ((err as any)?.name === 'NotAllowedError') playViaEngineFallback()
    })
  }, [exiting, onExited, animationDone, shouldAutoPlay, playViaEngineFallback])

  return (
    <div
      className={clsx(
        styles.wrapper,
        // Exit takes precedence: if the parent is animating us out, we're
        // not also playing the load-in. Avoids the visual oddity of an
        // arrival-then-departure flicker on a fast add-then-regen race.
        exiting
          ? styles.wrapperExiting
          : isFresh && !animationDone && styles.wrapperFresh,
      )}
      onAnimationEnd={onWrapperAnimationEnd}
    >
      <div className={styles.wrapperInner}>
        <div
          className={clsx(
            styles.player,
            isUser && styles.playerUser,
            regenerating && styles.playerRegenerating,
          )}
          title={title}
          role="group"
          aria-label="Audio playback"
          aria-busy={regenerating || undefined}
        >
          <button
            type="button"
            className={styles.playBtn}
            onClick={togglePlay}
            aria-label={isPlaying || enginePlaying ? 'Pause' : 'Play'}
            aria-pressed={isPlaying || enginePlaying}
          >
            {isPlaying || enginePlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>

          <input
            type="range"
            className={clsx(styles.slider, styles.sliderSeek)}
            min={0}
            max={seekMax}
            step={0.01}
            value={Math.min(currentTime, seekMax)}
            onChange={onSeekChange}
            disabled={duration <= 0}
            aria-label="Seek"
            // --progress drives the linear-gradient fill on the track
            // pseudo-element. Cast via CSSProperties since CSS vars aren't
            // in the standard React style typings.
            style={{ ['--progress' as any]: `${seekProgressPct}%` } as CSSProperties}
          />

          <span className={styles.time}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className={styles.volumeWrap}>
            <button
              ref={volumeButtonRef}
              type="button"
              className={styles.volumeBtn}
              onClick={openVolume}
              aria-label="Volume"
              aria-haspopup="true"
              aria-expanded={volumeOpen}
            >
              {displayVolume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            {volumeOpen && (
              <div ref={volumePopoverRef} className={styles.volumePopover} role="dialog">
                <button
                  type="button"
                  className={styles.volumeMuteBtn}
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                >
                  {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>
                <input
                  type="range"
                  className={clsx(styles.slider, styles.sliderVolume)}
                  min={0}
                  max={1}
                  step={0.01}
                  value={displayVolume}
                  onChange={onVolumeChange}
                  aria-label="Volume level"
                  style={{ ['--progress' as any]: `${volumeProgressPct}%` } as CSSProperties}
                />
              </div>
            )}
          </div>

          {onDelete && (
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={onDelete}
              aria-label="Delete saved audio"
              title="Delete saved audio"
              disabled={regenerating}
            >
              <Trash2 size={12} />
            </button>
          )}

          <audio
            ref={audioRef}
            preload="metadata"
            src={src}
          />

          {/* Regenerating overlay — covers the player pill while a save-first
              regen is in flight. Keeps the row height stable (zero layout
              shift) while still giving the user visible feedback that their
              regen click took effect. Pointer-events: none on the dim layer
              so the spinner doesn't intercept clicks; the underlying
              controls are aria-busy anyway. */}
          {regenerating && (
            <div className={styles.regenOverlay} role="status" aria-live="polite">
              <Loader2 size={14} className={styles.regenSpinner} />
              <span className={styles.regenLabel}>Regenerating…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
