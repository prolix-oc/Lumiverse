import { get, post, del, type RequestOptions } from './client'
import type { AndroidNotificationInfo, AndroidPushRegistration } from '@/lib/android-native'

export interface PushSubscriptionRecord {
  type: 'web_push' | 'tauri_desktop' | 'ios_apns' | 'android_native'
  id: string
  user_id: string
  endpoint?: string
  device_id?: string
  user_agent: string
  label: string
  platform?: string
  bundle_id?: string
  environment?: 'development' | 'production'
  delivery_mode?: 'direct' | 'relay'
  transport?: 'local' | 'fcm'
  project_id?: string | null
  created_at: number
  updated_at: number
  last_seen_at?: number | null
}

export interface DesktopNotificationEnrollment {
  destination: PushSubscriptionRecord & { type: 'tauri_desktop'; device_id: string }
  credential: string
  serverInstanceId: string
}

export interface PushTestResult {
  success: boolean
  sent: number
  reason?: 'no_subscriptions' | 'disabled' | 'event_disabled' | 'user_active'
}

export const pushApi = {
  getAndroidInfo() {
    return get<AndroidNotificationInfo>('/push/android/info')
  },
  subscribeAndroid(input: AndroidPushRegistration, options?: RequestOptions) {
    return post<{ destination: PushSubscriptionRecord; credential: string; serverInstanceId: string }>('/push/android', {
      ...input, serverOrigin: window.location.origin, label: 'Lumiverse Android', userAgent: navigator.userAgent,
    }, options)
  },
  getIOSInfo(bundleId?: string) {
    return get<{ configured: boolean; bundleId: string; reason: string | null; delivery?: 'direct' | 'relay'; relayUrl?: string; encryptionRequired?: boolean }>(
      '/push/ios/info' + (bundleId ? `?bundleId=${encodeURIComponent(bundleId)}` : ''))
  },
  subscribeIOS(input: { deviceId: string; deviceToken: string; bundleId: string; environment: 'development' | 'production';
    delivery?: 'relay' | 'direct'; relayCredential?: string; encryption?: { key: string; keyId: string } }, options?: RequestOptions) {
    return post<PushSubscriptionRecord>('/push/ios', { ...input, serverOrigin: window.location.origin,
      label: 'Lumiverse iOS', userAgent: navigator.userAgent }, options)
  },
  getVapidPublicKey() {
    return get<{ publicKey: string }>('/push/vapid-public-key')
  },

  getDesktopInfo() {
    return get<{ serverInstanceId: string }>('/push/desktop/info')
  },

  listSubscriptions(options?: RequestOptions) {
    return get<PushSubscriptionRecord[]>('/push/subscriptions', undefined, options)
  },

  subscribe(subscription: PushSubscriptionJSON) {
    return post<PushSubscriptionRecord>('/push/subscriptions', {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userAgent: navigator.userAgent,
    })
  },

  subscribeDesktop(input: { deviceId: string; label: string; platform: string }) {
    return post<DesktopNotificationEnrollment>('/push/desktop', {
      ...input,
      userAgent: navigator.userAgent,
    })
  },

  unsubscribe(id: string) {
    return del<{ success: boolean }>(`/push/subscriptions/${id}`)
  },

  test(destinationId?: string) {
    return post<PushTestResult>('/push/subscriptions/test', { destinationId })
  },
}
