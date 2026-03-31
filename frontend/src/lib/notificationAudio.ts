/**
 * Singleton Audio element for playing notification pings when a
 * backgrounded chat finishes generating.
 *
 * Mobile Safari locks audio per-element, so we reuse one element and
 * swap its `src` rather than creating new Audio() each time.
 *
 * Call `unlockNotificationAudio()` during a user gesture (e.g. send
 * button click) to satisfy autoplay policy, then call
 * `playNotificationPing()` freely from WebSocket handlers.
 */

const SILENCE_SRC = '/silence.mp3'
const PING_SRC = '/message-received.mp3'

let audio: HTMLAudioElement | null = null
let unlocked = false

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(SILENCE_SRC)
    audio.volume = 0.5
  }
  return audio
}

/** Play silence during a user gesture to unlock the element for later programmatic playback. */
export function unlockNotificationAudio(): void {
  if (unlocked) return
  const el = getAudio()
  el.src = SILENCE_SRC
  el.play().then(() => {
    unlocked = true
  }).catch(() => {
    // Browser still blocking — will retry on next gesture
  })
}

/** Play the notification ping. No-ops if the element was never unlocked. */
export function playNotificationPing(): void {
  if (!unlocked) return
  const el = getAudio()
  el.src = PING_SRC
  el.currentTime = 0
  el.play().catch(() => {
    // Swallow — user may have revoked audio permission
  })
}
