import { getTauriMobilePlatform, hasTauriDesktopBridge } from '../desktopWebView'
import { hasIOSNativeBridge } from '../ios-native'

// Mirror the additive public contract so core can ship before the next types
// package release, as with theme-authoring.ts.
export const CLIENT_HOST_CAPABILITIES = Object.freeze({ 'client-info-v1': 1 } as const)

export type SpindleClientKind = 'browser' | 'pwa' | 'desktop' | 'mobile'
export type SpindleClientPlatform = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown'

export interface SpindleClientInfo {
  readonly kind: SpindleClientKind
  readonly platform: SpindleClientPlatform
  readonly isMobile: boolean
  readonly bridges: {
    readonly desktop: boolean
    readonly ios: boolean
    readonly android: boolean
  }
}

export interface SpindleClientAPI {
  getInfo(): SpindleClientInfo
}

type ClientNavigator = Navigator & {
  standalone?: boolean
  userAgentData?: { platform?: string; mobile?: boolean }
}

type NativeWindow = Window & {
  __TAURI_INTERNALS__?: { invoke?: unknown }
  __LUMIVERSE_IOS_NATIVE__?: { request?: unknown }
}

function browserPlatform(nav: ClientNavigator | undefined): SpindleClientPlatform {
  const ua = nav?.userAgent ?? ''
  const platform = nav?.userAgentData?.platform || nav?.platform || ''
  // iPadOS can send a desktop Mac UA. Touch Macs are the host's iPadOS signal.
  if (/iPad|iPhone|iPod/i.test(ua) || /ios/i.test(platform)
    || (platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1)) return 'ios'
  // Android must be checked before Linux, and iPadOS before macOS.
  if (/android/i.test(`${platform} ${ua}`)) return 'android'
  if (/mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/win/i.test(platform) || /Windows/i.test(ua)) return 'windows'
  if (/linux/i.test(`${platform} ${ua}`)) return 'linux'
  return 'unknown'
}

function readClientInfo(): SpindleClientInfo {
  const host = typeof window === 'undefined' ? undefined : window as NativeWindow
  const nav = host?.navigator as ClientNavigator | undefined
  const root = typeof document === 'undefined' ? undefined : document.documentElement
  const mobilePlatform = getTauriMobilePlatform()
  const desktop = !mobilePlatform && (hasTauriDesktopBridge() || root?.hasAttribute('data-tauri-desktop') === true)
  const pwa = nav?.standalone === true || [
    'standalone', 'minimal-ui', 'window-controls-overlay',
  ].some(mode => host?.matchMedia?.(`(display-mode: ${mode})`).matches === true)
  const kind: SpindleClientKind = mobilePlatform ? 'mobile' : desktop ? 'desktop' : pwa ? 'pwa' : 'browser'
  const desktopPlatform = root?.getAttribute('data-platform')
  const platform = mobilePlatform ?? (desktop && (
    desktopPlatform === 'macos' || desktopPlatform === 'windows' || desktopPlatform === 'linux'
  ) ? desktopPlatform : browserPlatform(nav))
  const tauriBridge = typeof host?.__TAURI_INTERNALS__?.invoke === 'function'

  return Object.freeze({
    kind,
    platform,
    isMobile: kind === 'mobile' || (kind !== 'desktop' && (
      platform === 'ios' || platform === 'android' || nav?.userAgentData?.mobile === true
    )),
    bridges: Object.freeze({
      desktop: kind === 'desktop' && tauriBridge,
      ios: mobilePlatform === 'ios' && hasIOSNativeBridge()
        && typeof host?.__LUMIVERSE_IOS_NATIVE__?.request === 'function',
      android: mobilePlatform === 'android' && tauriBridge,
    }),
  })
}

export function createFrontendClientAPI(assertActive: () => void): SpindleClientAPI {
  return Object.freeze({
    getInfo() {
      assertActive()
      return readClientInfo()
    },
  })
}
