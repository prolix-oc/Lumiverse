import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'
import { hasAndroidNativeBridge, androidNativeRequest } from './android-native'
import { createIOSForegroundSync } from './ios-foreground-sync'
import { createForegroundSync } from './foreground-sync'

export function characterWidgetNative() {
  if (hasIOSNativeBridge()) return { request: iosNativeRequest, sync: createIOSForegroundSync }
  if (!hasAndroidNativeBridge()) return null
  return {
    request: androidNativeRequest,
    sync: (run: (signal: AbortSignal) => Promise<void>, pollMs?: number) => createForegroundSync(run, pollMs, {
      foreground: () => {
        const active = (window as Window & { __LUMIVERSE_ANDROID_ACTIVE__?: boolean }).__LUMIVERSE_ANDROID_ACTIVE__
        return active ?? document.visibilityState !== 'hidden'
      },
      subscribe: onState => {
        const changed = () => onState()
        window.addEventListener('lumiverse:android-app-state', changed)
        window.addEventListener('lumiverse:android-resume', changed)
        return () => {
          window.removeEventListener('lumiverse:android-app-state', changed)
          window.removeEventListener('lumiverse:android-resume', changed)
        }
      },
    }),
  }
}
