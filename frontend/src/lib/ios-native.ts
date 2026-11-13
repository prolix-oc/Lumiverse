import { getTauriMobilePlatform } from './desktopWebView'

interface IOSBridge {
  version: number
  request(action: string, payload?: Record<string, unknown>): Promise<unknown>
}

export function isNativeIOS(): boolean { return getTauriMobilePlatform() === 'ios' }
export function hasIOSNativeBridge(): boolean {
  return isNativeIOS() && (window as Window & { __LUMIVERSE_IOS_NATIVE__?: IOSBridge }).__LUMIVERSE_IOS_NATIVE__?.version === 1
}

export async function iosNativeRequest<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const bridge = (window as Window & { __LUMIVERSE_IOS_NATIVE__?: IOSBridge }).__LUMIVERSE_IOS_NATIVE__
  if (!hasIOSNativeBridge() || !bridge) throw new Error('Update the Lumiverse iOS app to enable native permissions.')
  try { return await bridge.request(action, payload) as T }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)) }
}

export interface IOSNotificationStatus {
  available: boolean
  permission: NotificationPermission
  deviceId: string
  bundleId: string
  environment: 'development' | 'production'
  reason: string | null
  relayAvailable?: boolean
}
export interface IOSPushRegistration {
  deviceId: string
  deviceToken: string
  bundleId: string
  environment: 'development' | 'production'
  delivery?: 'relay' | 'direct'
  relayCredential?: string
  encryption?: { key: string; keyId: string }
}

export const getIOSNotificationStatus = () => iosNativeRequest<IOSNotificationStatus>('notifications.status')
export const registerIOSPush = (delivery: 'relay' | 'direct' = 'direct', relayUrl?: string) =>
  iosNativeRequest<IOSPushRegistration>('notifications.register', { delivery, ...(relayUrl ? { relayUrl } : {}) })
