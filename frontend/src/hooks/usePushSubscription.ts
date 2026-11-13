import { useState, useEffect, useCallback } from 'react'
import { pushApi, type PushSubscriptionRecord, type PushTestResult } from '@/api/push'
import { isNativeIOS } from '@/lib/ios-native'
import { useIOSPushSubscription } from './useIOSPushSubscription'
import { isNativeAndroid } from '@/lib/android-native'
import { useAndroidPushSubscription } from './useAndroidPushSubscription'
import {
  clearDesktopNotificationEnrollment,
  getDesktopNotificationDevice,
  getDesktopNotificationPermission,
  getDesktopNotificationTransportStatus,
  isTauriDesktop,
  saveDesktopNotificationEnrollment,
  type DesktopNotificationTransportStatus,
} from '@/lib/desktop-notifications'

interface PushCapability {
  checked: boolean
  supported: boolean
  reason: string | null
  registrationStatus: 'ready' | 'pending' | 'missing' | 'error'
  registrationReason: string | null
}

const DEFAULT_PUSH_CAPABILITY: PushCapability = {
  checked: false,
  supported: false,
  reason: null,
  registrationStatus: 'pending',
  registrationReason: null,
}

const SERVICE_WORKER_READY_TIMEOUT_MS = 15_000
const PUSH_BROWSER_OP_TIMEOUT_MS = 20_000
const PUSH_SUBSCRIPTION_STATE_TIMEOUT_MESSAGE = 'Timed out while checking the browser push subscription state.'
const PUSH_SUBSCRIBE_TIMEOUT_MESSAGE = 'Timed out while the browser was creating the push subscription.'
const CHROMIUM_PUSH_TIMEOUT_REASON =
  'Chromium timed out while contacting its push service. On macOS this is usually a stuck or blocked Google push/FCM connection; try Chrome/Edge stable, disable VPN/firewall filtering for Google push endpoints, or reinstall/reset the PWA notification permission.'
const NATIVE_TRANSPORT_REQUIRED_REASON =
  'This frontend requires a newer Lumiverse Desktop build with the native notification transport. Rebuild and reinstall the desktop companion, then relaunch it.'

function nativeTransportRegistration(status: DesktopNotificationTransportStatus): Pick<PushCapability, 'registrationStatus' | 'registrationReason'> {
  if (status.state === 'connected' || status.state === 'not_enrolled') {
    return { registrationStatus: 'ready', registrationReason: null }
  }
  if (status.state === 'connecting' || status.state === 'retrying') {
    return { registrationStatus: 'pending', registrationReason: status.lastError }
  }
  return {
    registrationStatus: 'error',
    registrationReason: status.lastError || 'The native notification transport is stopped.',
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ])
}

async function waitForReadyRegistration(timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

async function inspectRegistrationState(): Promise<Pick<PushCapability, 'registrationStatus' | 'registrationReason'>> {
  try {
    const existing = await navigator.serviceWorker.getRegistration()
    if (existing?.active && existing.pushManager) {
      return { registrationStatus: 'ready', registrationReason: null }
    }

    const ready = await waitForReadyRegistration()
    if (ready?.pushManager) {
      return { registrationStatus: 'ready', registrationReason: null }
    }

    if (existing?.installing || existing?.waiting || navigator.serviceWorker.controller) {
      return {
        registrationStatus: 'pending',
        registrationReason: 'The service worker is still activating. Try again in a moment.',
      }
    }

    return {
      registrationStatus: 'missing',
      registrationReason: 'No active service worker registration is available for push yet.',
    }
  } catch {
    return {
      registrationStatus: 'error',
      registrationReason: 'The service worker failed to become ready for push registration.',
    }
  }
}

async function getPushRegistrationOrThrow(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing?.active && existing.pushManager) return existing

  const ready = await waitForReadyRegistration()
  if (ready?.pushManager) return ready

  throw new Error('The service worker is still activating. Reload the page or try again in a moment.')
}

async function getExistingPushSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  return withTimeout(
    reg.pushManager.getSubscription(),
    PUSH_BROWSER_OP_TIMEOUT_MS,
    PUSH_SUBSCRIPTION_STATE_TIMEOUT_MESSAGE
  )
}

async function detectPushCapability(): Promise<Omit<PushCapability, 'checked'>> {
  if (isTauriDesktop()) {
    try {
      const status = await getDesktopNotificationTransportStatus()
      if (status.transportVersion !== 1) throw new Error('Unsupported native notification transport')
      return {
        supported: true,
        reason: null,
        ...nativeTransportRegistration(status),
      }
    } catch {
      return {
        supported: false,
        reason: NATIVE_TRANSPORT_REQUIRED_REASON,
        registrationStatus: 'error',
        registrationReason: NATIVE_TRANSPORT_REQUIRED_REASON,
      }
    }
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'Push requires HTTPS or localhost.',
      registrationStatus: 'error',
      registrationReason: null,
    }
  }
  if (!('serviceWorker' in navigator)) {
    return {
      supported: false,
      reason: 'Service workers are not available in this browser.',
      registrationStatus: 'missing',
      registrationReason: null,
    }
  }
  if (!('PushManager' in window)) {
    return {
      supported: false,
      reason: 'The Push API is not available in this browser.',
      registrationStatus: 'missing',
      registrationReason: null,
    }
  }
  if (!('Notification' in window)) {
    return {
      supported: false,
      reason: 'Notifications are not available in this browser.',
      registrationStatus: 'missing',
      registrationReason: null,
    }
  }
  if (!('showNotification' in ServiceWorkerRegistration.prototype)) {
    return {
      supported: false,
      reason: 'Service worker notifications are not supported here.',
      registrationStatus: 'missing',
      registrationReason: null,
    }
  }

  const registration = await inspectRegistrationState()
  return {
    supported: true,
    reason: null,
    registrationStatus: registration.registrationStatus,
    registrationReason: registration.registrationReason,
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length)) as Uint8Array<ArrayBuffer>
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function serializePushSubscription(sub: PushSubscription): PushSubscriptionJSON {
  const json = sub.toJSON()
  return {
    endpoint: json.endpoint || sub.endpoint,
    expirationTime: json.expirationTime ?? sub.expirationTime ?? null,
    keys: {
      p256dh: json.keys?.p256dh || arrayBufferToBase64Url(sub.getKey('p256dh')),
      auth: json.keys?.auth || arrayBufferToBase64Url(sub.getKey('auth')),
    },
  }
}

function describeSubscribeError(error: unknown): string {
  if (typeof error === 'string' && error) return error
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return 'Timed out while waiting for the service worker to become active for push registration.'
    }
    if (error.name === 'InvalidStateError') {
      return 'The browser reported a stale or invalid push registration. Try removing the device and subscribing again.'
    }
    if (error.name === 'NotAllowedError') {
      return 'The browser blocked push registration. Check the site notification permission and OS notification settings.'
    }
    if (
      error.message === PUSH_SUBSCRIPTION_STATE_TIMEOUT_MESSAGE ||
      error.message === PUSH_SUBSCRIBE_TIMEOUT_MESSAGE
    ) {
      return CHROMIUM_PUSH_TIMEOUT_REASON
    }
    if (error.message) return error.message
  }
  return 'Failed to subscribe this browser for push notifications.'
}

export function usePushSubscription() {
  const ios = isNativeIOS()
  const native = useIOSPushSubscription(ios)
  const android = isNativeAndroid()
  const nativeAndroid = useAndroidPushSubscription(android)
  const browserDesktop = useBrowserDesktopPushSubscription(!ios && !android)
  return ios ? native : android ? nativeAndroid : browserDesktop
}

function useBrowserDesktopPushSubscription(enabled: boolean) {
  const desktop = isTauriDesktop()
  const [capability, setCapability] = useState<PushCapability>(DEFAULT_PUSH_CAPABILITY)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>([])
  const [permissionState, setPermissionState] = useState<NotificationPermission>(
    enabled && !desktop && typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )
  const [desktopDeviceId, setDesktopDeviceId] = useState<string | null>(null)
  const [desktopDestinationId, setDesktopDestinationId] = useState<string | null>(null)
  const [nativeTransportStatus, setNativeTransportStatus] = useState<DesktopNotificationTransportStatus | null>(null)

  // Check current subscription status on mount
  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    detectPushCapability().then((result) => {
      if (cancelled) return
      setCapability({ checked: true, ...result })
      if (!result.supported) return

      if (desktop) {
        Promise.all([
          getDesktopNotificationDevice(),
          getDesktopNotificationPermission(),
          getDesktopNotificationTransportStatus(),
          pushApi.listSubscriptions(),
          pushApi.getDesktopInfo(),
        ]).then(([device, permission, transport, rows, info]) => {
          if (cancelled) return
          const destination = rows.find(
            (row) => row.type === 'tauri_desktop' && row.device_id === device.deviceId,
          )
          const enrolled = destination
            && device.enrollment?.destinationId === destination.id
            && device.enrollment.serverInstanceId === info.serverInstanceId
            && device.enrollment.serverOrigin === window.location.origin
          setDesktopDeviceId(device.deviceId)
          setDesktopDestinationId(enrolled ? destination.id : null)
          setNativeTransportStatus(transport)
          setPermissionState(permission)
          setSubscriptions(rows)
          setIsSubscribed(Boolean(enrolled))
          setCapability((prev) => ({
            ...prev,
            checked: true,
            ...nativeTransportRegistration(transport),
          }))
        }).catch((error) => {
          if (!cancelled) {
            setCapability((prev) => ({
              ...prev,
              checked: true,
              registrationStatus: 'error',
              registrationReason: error instanceof Error ? error.message : String(error),
            }))
          }
        })
        return
      }

      getPushRegistrationOrThrow().then(async (reg) => {
        if (cancelled) return
        const sub = await getExistingPushSubscription(reg)
        if (!cancelled) {
          setIsSubscribed(!!sub)
          setCapability((prev) => ({
            ...prev,
            checked: true,
            registrationStatus: 'ready',
            registrationReason: null,
          }))
        }
      }).catch((error) => {
        if (!cancelled) {
          setCapability((prev) => ({
            ...prev,
            checked: true,
            registrationStatus: 'pending',
            registrationReason: describeSubscribeError(error),
          }))
        }
      })

      pushApi.listSubscriptions().then((rows) => {
        if (!cancelled) setSubscriptions(rows)
      }).catch(() => {})
    })

    return () => {
      cancelled = true
    }
  }, [desktop, enabled])

  useEffect(() => {
    if (!desktop || !enabled) return
    let cancelled = false
    const refreshTransport = async () => {
      try {
        const status = await getDesktopNotificationTransportStatus()
        if (cancelled) return
        setNativeTransportStatus(status)
        setCapability((prev) => ({
          ...prev,
          checked: true,
          supported: status.transportVersion === 1,
          reason: status.transportVersion === 1 ? null : NATIVE_TRANSPORT_REQUIRED_REASON,
          ...nativeTransportRegistration(status),
        }))
      } catch {
        if (cancelled) return
        setNativeTransportStatus(null)
        setCapability({
          checked: true,
          supported: false,
          reason: NATIVE_TRANSPORT_REQUIRED_REASON,
          registrationStatus: 'error',
          registrationReason: NATIVE_TRANSPORT_REQUIRED_REASON,
        })
      }
    }
    void refreshTransport()
    const timer = window.setInterval(refreshTransport, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [desktop, enabled])

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!capability.supported) {
      throw new Error(capability.reason || 'Push notifications are not supported in this browser.')
    }

    const permission = desktop
      ? await getDesktopNotificationPermission(true)
      : await Notification.requestPermission()
    setPermissionState(permission)
    if (permission !== 'granted') return false

    try {
      if (desktop) {
        const transport = await getDesktopNotificationTransportStatus().catch(() => null)
        if (!transport || transport.transportVersion !== 1) {
          throw new Error(NATIVE_TRANSPORT_REQUIRED_REASON)
        }
        const device = desktopDeviceId
          ? { deviceId: desktopDeviceId }
          : await getDesktopNotificationDevice()
        const enrollment = await pushApi.subscribeDesktop({
          deviceId: device.deviceId,
          label: 'Lumiverse Desktop',
          platform: navigator.platform || 'desktop',
        })
        await saveDesktopNotificationEnrollment({
          deviceId: device.deviceId,
          destinationId: enrollment.destination.id,
          credential: enrollment.credential,
          serverInstanceId: enrollment.serverInstanceId,
          serverOrigin: window.location.origin,
        })
        const restartedTransport = await getDesktopNotificationTransportStatus()
        setDesktopDeviceId(device.deviceId)
        setDesktopDestinationId(enrollment.destination.id)
        setNativeTransportStatus(restartedTransport)
        setCapability((prev) => ({
          ...prev,
          ...nativeTransportRegistration(restartedTransport),
        }))
        setIsSubscribed(true)
        setSubscriptions((prev) => [
          enrollment.destination,
          ...prev.filter((row) => row.id !== enrollment.destination.id),
        ])
        return true
      }

      const reg = await getPushRegistrationOrThrow()
      const existing = await getExistingPushSubscription(reg)
      const sub = existing ?? await (async () => {
        const { publicKey } = await pushApi.getVapidPublicKey()
        return withTimeout(
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          }),
          PUSH_BROWSER_OP_TIMEOUT_MS,
          PUSH_SUBSCRIBE_TIMEOUT_MESSAGE
        )
      })()

      const record = await pushApi.subscribe(serializePushSubscription(sub))
      setIsSubscribed(true)
      setCapability((prev) => ({
        ...prev,
        registrationStatus: 'ready',
        registrationReason: null,
      }))
      setSubscriptions((prev) => {
        const filtered = prev.filter((s) => s.id !== record.id)
        return [record, ...filtered]
      })
      return true
    } catch (error) {
      const message = describeSubscribeError(error)
      setCapability((prev) => ({
        ...prev,
        registrationStatus: 'error',
        registrationReason: message,
      }))
      throw new Error(message)
    }
  }, [capability, desktop, desktopDeviceId])

  const unsubscribe = useCallback(async (id: string): Promise<void> => {
    const destination = subscriptions.find((row) => row.id === id)
    await pushApi.unsubscribe(id)
    setSubscriptions((prev) => prev.filter((s) => s.id !== id))

    if (desktop) {
      if (destination?.type === 'tauri_desktop' && destination.device_id === desktopDeviceId) {
        await clearDesktopNotificationEnrollment(id)
        setDesktopDestinationId(null)
        setIsSubscribed(false)
      }
      return
    }

    // If we just removed the current browser's subscription, update browser state
    const reg = await navigator.serviceWorker.ready
    const sub = await getExistingPushSubscription(reg)
    if (sub) {
      const remaining = subscriptions.find(
        (s) => s.id !== id && s.endpoint === sub.endpoint
      )
      if (!remaining) {
        await sub.unsubscribe()
        setIsSubscribed(false)
      }
    }
  }, [desktop, desktopDeviceId, subscriptions])

  const unsubscribeAll = useCallback(async (): Promise<void> => {
    if (desktop) {
      await clearDesktopNotificationEnrollment()
      setDesktopDestinationId(null)
    } else {
      // Unsubscribe browser-level
      const reg = await navigator.serviceWorker.ready
      const sub = await getExistingPushSubscription(reg)
      if (sub) await sub.unsubscribe()
    }

    // Unsubscribe all server-side
    await Promise.allSettled(subscriptions.map((s) => pushApi.unsubscribe(s.id)))
    setSubscriptions([])
    setIsSubscribed(false)
  }, [desktop, subscriptions])

  const testPush = useCallback(async (): Promise<PushTestResult> => {
    if (desktop && nativeTransportStatus?.state !== 'connected') {
      throw new Error(
        nativeTransportStatus?.lastError
        || 'The native notification transport is not connected yet. Try again in a moment.'
      )
    }
    return pushApi.test(desktop ? desktopDestinationId ?? undefined : undefined)
  }, [desktop, desktopDestinationId, nativeTransportStatus])

  const refresh = useCallback(async () => {
    if (desktop) {
      const [subs, device, permission, info, transport] = await Promise.all([
        pushApi.listSubscriptions(),
        getDesktopNotificationDevice(),
        getDesktopNotificationPermission(),
        pushApi.getDesktopInfo(),
        getDesktopNotificationTransportStatus(),
      ])
      const destination = subs.find(
        (row) => row.type === 'tauri_desktop' && row.device_id === device.deviceId,
      )
      const enrolled = destination
        && device.enrollment?.destinationId === destination.id
        && device.enrollment.serverInstanceId === info.serverInstanceId
        && device.enrollment.serverOrigin === window.location.origin
      setSubscriptions(subs)
      setDesktopDeviceId(device.deviceId)
      setDesktopDestinationId(enrolled ? destination.id : null)
      setNativeTransportStatus(transport)
      setPermissionState(permission)
      setIsSubscribed(Boolean(enrolled))
      setCapability((prev) => ({
        ...prev,
        checked: true,
        ...nativeTransportRegistration(transport),
      }))
      return
    }
    const [subs, registration] = await Promise.all([
      pushApi.listSubscriptions(),
      capability.supported ? inspectRegistrationState() : Promise.resolve({
        registrationStatus: capability.registrationStatus,
        registrationReason: capability.registrationReason,
      }),
    ])
    setSubscriptions(subs)
    setCapability((prev) => ({
      ...prev,
      checked: true,
      registrationStatus: registration.registrationStatus,
      registrationReason: registration.registrationReason,
    }))
  }, [capability.registrationReason, capability.registrationStatus, capability.supported, desktop])

  return {
    isSupported: capability.supported,
    supportChecked: capability.checked,
    unsupportedReason: capability.reason,
    registrationStatus: capability.registrationStatus,
    registrationReason: capability.registrationReason,
    isSubscribed,
    permissionState,
    subscriptions,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    testPush,
    refresh,
    nativeTransportStatus,
    registrationKind: desktop ? 'native' as const : 'service_worker' as const,
  }
}
