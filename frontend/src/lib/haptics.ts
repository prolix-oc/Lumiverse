import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

export type HapticFeedback = 'selection' | 'impact' | 'success' | 'error'

/** Feedback is best effort; it must never interrupt a gesture or action. */
export function playHaptic(feedback: HapticFeedback, vibrationMs = 12): void {
  if (hasIOSNativeBridge()) {
    void iosNativeRequest('haptics.play', { feedback }).catch(() => {})
    return
  }
  try {
    if (typeof navigator !== 'undefined') navigator.vibrate?.(vibrationMs)
  } catch { /* Some browser contexts disallow vibration. */ }
}
