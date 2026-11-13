import {
  hostIntentEventName,
  isClaimableHostIntentName,
} from './spindle/host-intent-registry'

/** Dispatch a cosmetic host intent. Returns true when a handler claimed it. */
export function requestHostIntent<T>(name: string, detail: T): boolean {
  if (!isClaimableHostIntentName(name)) return false
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false

  try {
    const event = new CustomEvent(hostIntentEventName(name), {
      detail,
      cancelable: true,
    })
    window.dispatchEvent(event)
    return event.defaultPrevented
  } catch {
    return false
  }
}
