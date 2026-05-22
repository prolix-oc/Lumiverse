import { useState, useEffect, useCallback } from 'react'
import { pushApi, type PushSubscriptionRecord, type PushTestResult } from '@/api/push'

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
    'Timed out while checking the browser push subscription state.'
  )
}

async function detectPushCapability(): Promise<Omit<PushCapability, 'checked'>> {
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
    if (error.message) return error.message
  }
  return 'Failed to subscribe this browser for push notifications.'
}

export function usePushSubscription() {
  const [capability, setCapability] = useState<PushCapability>(DEFAULT_PUSH_CAPABILITY)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>([])
  const [permissionState, setPermissionState] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  // Check current subscription status on mount
  useEffect(() => {
    let cancelled = false

    detectPushCapability().then((result) => {
      if (cancelled) return
      setCapability({ checked: true, ...result })
      if (!result.supported) return

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
  }, [])

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!capability.supported) {
      throw new Error(capability.reason || 'Push notifications are not supported in this browser.')
    }

    const permission = await Notification.requestPermission()
    setPermissionState(permission)
    if (permission !== 'granted') return false

    try {
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
          'Timed out while the browser was creating the push subscription.'
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
  }, [capability])

  const unsubscribe = useCallback(async (id: string): Promise<void> => {
    await pushApi.unsubscribe(id)
    setSubscriptions((prev) => prev.filter((s) => s.id !== id))

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
  }, [subscriptions])

  const unsubscribeAll = useCallback(async (): Promise<void> => {
    // Unsubscribe browser-level
    const reg = await navigator.serviceWorker.ready
    const sub = await getExistingPushSubscription(reg)
    if (sub) await sub.unsubscribe()

    // Unsubscribe all server-side
    await Promise.allSettled(subscriptions.map((s) => pushApi.unsubscribe(s.id)))
    setSubscriptions([])
    setIsSubscribed(false)
  }, [subscriptions])

  const testPush = useCallback(async (): Promise<PushTestResult> => {
    return pushApi.test()
  }, [])

  const refresh = useCallback(async () => {
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
  }, [capability.registrationReason, capability.registrationStatus, capability.supported])

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
  }
}
