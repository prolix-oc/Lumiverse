import { getTauriMobilePlatform } from './desktopWebView'
import { uuidv4 } from './uuid'

interface MessageBridge { postMessage(message: string): void; onmessage?: (event: { data: string }) => void }
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
let installed: MessageBridge | undefined
export const isNativeAndroid = () => getTauriMobilePlatform() === 'android'
const bridge = () => (window as Window & { lumiverseNotifications?: MessageBridge }).lumiverseNotifications
export const hasAndroidNativeBridge = () => isNativeAndroid() && !!bridge()?.postMessage

export function androidNativeRequest<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const native = bridge()
  if (!hasAndroidNativeBridge() || !native) return Promise.reject(new Error('Update the Lumiverse Android app to enable native notifications.'))
  if (installed !== native) {
    installed = native
    native.onmessage = event => {
      try {
        const reply = JSON.parse(event.data)
        const request = pending.get(reply.id)
        if (!request) return
        clearTimeout(request.timer); pending.delete(reply.id)
        if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.result)
      } catch { /* Ignore malformed native replies. */ }
    }
  }
  return new Promise<T>((resolve, reject) => {
    const id = uuidv4()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native notification request timed out.')) }, 30_000)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    try { native.postMessage(JSON.stringify({ id, action, payload })) }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
}

export interface AndroidNotificationStatus {
  available: boolean
  permission: NotificationPermission
  deviceId: string
  transport: 'local' | 'fcm'
  projectId: string | null
  reason: string | null
  enrollment: { destinationId: string; serverOrigin: string; serverInstanceId: string; accountId: string } | null
  connected: boolean
  relayAvailable?: boolean
  encryptionVersion?: number
  packageName?: string
}
export interface AndroidNotificationInfo {
  configured: boolean; projectId: string | null; serverInstanceId: string; reason: string | null
  delivery?: 'direct' | 'relay'; relayUrl?: string; encryptionRequired?: boolean; encryptionVersion?: number; packageName?: string
}
export interface AndroidPushRegistration {
  deviceId: string; accountId?: string; transport: 'local' | 'fcm'; deviceToken?: string; projectId?: string
  packageName?: string; delivery?: 'direct' | 'relay'; enrollmentId?: string; relayCredential?: string
  encryption?: { key: string; keyId: string }
}
export const getAndroidNotificationStatus = () => androidNativeRequest<AndroidNotificationStatus>('notifications.status')
export async function registerAndroidPush(info?: AndroidNotificationInfo, signal?: AbortSignal) {
  type Pending = { pending: true; enrollmentId: string }
  let result = await androidNativeRequest<AndroidPushRegistration | Pending | null>('notifications.register', info ? {
    delivery: info.delivery || 'direct', relayUrl: info.relayUrl, serverInstanceId: info.serverInstanceId,
    encryptionVersion: info.encryptionVersion,
  } : {})
  const pendingId = result && 'pending' in result ? result.enrollmentId : undefined
  try {
    const deadline = Date.now() + 120_000
    while (result && 'pending' in result) {
      if (signal?.aborted) throw new DOMException('Enrollment cancelled', 'AbortError')
      if (Date.now() >= deadline) throw new Error('Notification verification expired. Try again.')
      await new Promise(resolve => window.setTimeout(resolve, 750))
      if (signal?.aborted) throw new DOMException('Enrollment cancelled', 'AbortError')
      result = await androidNativeRequest<AndroidPushRegistration | Pending>('notifications.poll', { enrollmentId: result.enrollmentId })
    }
    if (signal?.aborted) throw new DOMException('Enrollment cancelled', 'AbortError')
    return result as AndroidPushRegistration | null
  } catch (error) {
    if (pendingId) await androidNativeRequest('notifications.cancel', { enrollmentId: pendingId }).catch(() => {})
    throw error
  }
}
export function androidRegistrationReason(status: AndroidNotificationStatus, info: AndroidNotificationInfo) {
  if (!status.available) return status.reason
  if (status.transport !== 'fcm') return null
  if (!info.configured) return info.reason
  if (info.projectId !== status.projectId) return 'The APK and server Firebase projects do not match.'
  if (info.delivery === 'relay' && (!status.relayAvailable || status.encryptionVersion !== 1)) return 'Update the Lumiverse Android app to enable verified relay notifications.'
  if (info.packageName && status.packageName && info.packageName !== status.packageName) return 'The Android package and server configuration do not match.'
  return null
}
export const clearAndroidEnrollment = (destinationId?: string) => androidNativeRequest('notifications.clear', { destinationId })
