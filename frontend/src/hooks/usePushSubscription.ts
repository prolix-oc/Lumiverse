import { useState, useEffect, useCallback } from 'react'
import { pushApi, type PushSubscriptionRecord, type PushTestResult } from '@/api/push'

interface PushCapability {
  checked: boolean
  supported: boolean
  reason: string | null
}

const DEFAULT_PUSH_CAPABILITY: PushCapability = {
  checked: false,
  supported: false,
  reason: null,
}

async function detectPushCapability(): Promise<Omit<PushCapability, 'checked'>> {
  if (!window.isSecureContext) {
    return { supported: false, reason: 'Push requires HTTPS or localhost.' }
  }
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'Service workers are not available in this browser.' }
  }
  if (!('PushManager' in window)) {
    return { supported: false, reason: 'The Push API is not available in this browser.' }
  }
  if (!('Notification' in window)) {
    return { supported: false, reason: 'Notifications are not available in this browser.' }
  }
  if (!('showNotification' in ServiceWorkerRegistration.prototype)) {
    return { supported: false, reason: 'Service worker notifications are not supported here.' }
  }

  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ])

    if (!registration) {
      return { supported: false, reason: 'The service worker is not ready yet.' }
    }
    if (!registration.pushManager) {
      return { supported: false, reason: 'Push registration is not available on the active service worker.' }
    }
  } catch {
    return { supported: false, reason: 'The service worker failed to become ready for push registration.' }
  }

  return { supported: true, reason: null }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
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

      navigator.serviceWorker.ready.then(async (reg) => {
        if (cancelled) return
        const sub = await reg.pushManager.getSubscription()
        if (!cancelled) setIsSubscribed(!!sub)
      }).catch(() => {
        if (!cancelled) {
          setCapability({
            checked: true,
            supported: false,
            reason: 'The service worker failed to become ready for push registration.',
          })
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

    const { publicKey } = await pushApi.getVapidPublicKey()
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    })

    const record = await pushApi.subscribe(sub.toJSON())
    setIsSubscribed(true)
    setSubscriptions((prev) => {
      const filtered = prev.filter((s) => s.id !== record.id)
      return [record, ...filtered]
    })
    return true
  }, [capability])

  const unsubscribe = useCallback(async (id: string): Promise<void> => {
    await pushApi.unsubscribe(id)
    setSubscriptions((prev) => prev.filter((s) => s.id !== id))

    // If we just removed the current browser's subscription, update browser state
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
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
    const sub = await reg.pushManager.getSubscription()
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
    const subs = await pushApi.listSubscriptions()
    setSubscriptions(subs)
  }, [])

  return {
    isSupported: capability.supported,
    supportChecked: capability.checked,
    unsupportedReason: capability.reason,
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
