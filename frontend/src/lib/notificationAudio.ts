/**
 * Notification pings when a backgrounded chat finishes generating.
 * Mobile apps use short-lived Web Audio buffers so pings do not become
 * system media playback or leave lock-screen/notification playback controls.
 *
 * Browser sessions reuse one audio element because Mobile Safari locks
 * playback per-element. Desktop apps also use this element.
 *
 * Browser sessions call `unlockNotificationAudio()` during a user gesture.
 * Native WebViews allow playback directly without a silent unlock file.
 */

import { BASE_URL } from '@/api/client'
import { isTauriMobile, isTauriWebView } from '@/lib/desktopWebView'

const SILENCE_SRC = '/silence.mp3'
const DEFAULT_PING_SRC = '/message-received.mp3'
const CUSTOM_PING_PATH = `${BASE_URL}/notification-sounds/completion`

let audio: HTMLAudioElement | null = null
let unlocked = false
let unlockPromise: Promise<boolean> | null = null
let mobileRequest = 0
let stopMobilePing: (() => void) | null = null

async function playMobilePing(src: string): Promise<void> {
  const request = ++mobileRequest
  stopMobilePing?.()

  const response = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Notification sound failed (${response.status})`)
  const data = await response.arrayBuffer()
  if (request !== mobileRequest) return

  const AudioContextClass = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('Web Audio API is not supported')

  const context = new AudioContextClass()
  let source: AudioBufferSourceNode | null = null
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (stopMobilePing === dispose) stopMobilePing = null
    if (source) {
      source.onended = null
      try { source.stop() } catch { /* start() may have failed */ }
      source.disconnect()
    }
    // Release the native audio output after this short effect, including
    // decode/resume failures. Do not touch the page's TTS or media session.
    void context.close().catch(() => {})
  }
  stopMobilePing = dispose

  try {
    const buffer = await context.decodeAudioData(data)
    if (disposed) return
    if (context.state !== 'running') await context.resume()
    if (disposed) return
    const gain = context.createGain()
    gain.gain.value = 0.5
    gain.connect(context.destination)
    source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.onended = dispose
    source.start()
  } catch (error) {
    dispose()
    throw error
  }
}

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = isTauriWebView() ? new Audio() : new Audio(SILENCE_SRC)
    audio.volume = 0.5
  }
  return audio
}

/** Play silence during a user gesture to unlock the element for later programmatic playback. */
export function unlockNotificationAudio(): Promise<boolean> {
  // Our native WebViews allow playback without a gesture. Do not load or
  // play a dummy media file just because the user touched the app.
  if (isTauriWebView()) return Promise.resolve(true)
  if (unlocked) return Promise.resolve(true)
  if (unlockPromise) return unlockPromise
  const el = getAudio()
  el.src = SILENCE_SRC
  unlockPromise = el.play().then(() => {
    unlocked = true
    return true
  }).catch(() => {
    // Browser still blocking — will retry on next gesture
    return false
  }).finally(() => {
    unlockPromise = null
  })
  return unlockPromise
}

/**
 * Register one-time document-level listeners that unlock notification audio on
 * the first interaction anywhere in the app. This covers users who interact
 * with navigation, modals, drawers, extensions, or keyboard shortcuts before a
 * background chat finishes, instead of requiring a direct Send-button click.
 */
export function installNotificationAudioPrimer(): () => void {
  if (typeof document === 'undefined' || isTauriWebView()) return () => {}

  const events: (keyof DocumentEventMap)[] = ['pointerdown', 'keydown', 'touchstart']
  let disposed = false

  const handler = () => {
    if (disposed) return
    void unlockNotificationAudio().then((ok) => {
      if (ok) dispose()
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const e of events) document.removeEventListener(e, handler, true)
  }

  // Capture phase covers portals/extensions that stop propagation. Passive
  // keeps the primer from blocking touch scrolling.
  for (const e of events) {
    document.addEventListener(e, handler, { capture: true, passive: true })
  }

  return dispose
}

/**
 * Play the notification ping. Browser sessions must first unlock the element.
 *
 * Pass `customSoundVersion` (e.g. the user's `uploadedAt` unix-seconds
 * timestamp) to route playback through the user-uploaded sound at
 * `/api/v1/notification-sounds/completion`. The version is appended as a
 * query string so a re-upload busts the browser's audio cache.
 */
export function playNotificationPing(customSoundVersion?: number | null): void {
  void playNotificationSound(customSoundVersion).catch(() => {
    // Notification failures must not interrupt generation handling.
  })
}

/** Same playback path for settings previews, with errors exposed to the UI. */
export async function playNotificationSound(customSoundVersion?: number | null): Promise<void> {
  if (!unlocked && !isTauriWebView()) return
  const nextSrc = customSoundVersion
    ? `${CUSTOM_PING_PATH}?v=${customSoundVersion}`
    : DEFAULT_PING_SRC
  if (isTauriMobile()) return playMobilePing(nextSrc)
  const el = getAudio()
  el.src = nextSrc
  el.currentTime = 0
  await el.play()
}
