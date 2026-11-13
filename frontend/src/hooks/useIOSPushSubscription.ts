import { useCallback, useEffect, useState } from 'react'
import { pushApi, type PushSubscriptionRecord } from '@/api/push'
import { getIOSNotificationStatus, hasIOSNativeBridge, registerIOSPush } from '@/lib/ios-native'
import { getIOSAppState, subscribeIOSAppState } from '@/lib/ios-app-state'

export function useIOSPushSubscription(enabled: boolean) {
  const [checked, setChecked] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>([])
  const [destinationId, setDestinationId] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [delivery, setDelivery] = useState<'direct' | 'relay'>('direct')
  const [relayUrl, setRelayUrl] = useState<string>()
  const refresh = useCallback(async () => {
    try {
      const status = await getIOSNotificationStatus()
      setPermission(status.permission)
      // Load destinations even if APNs has subsequently been disabled on the server.
      const [info, rows] = await Promise.all([pushApi.getIOSInfo(status.bundleId), pushApi.listSubscriptions()])
      setDelivery(info.delivery || 'direct'); setRelayUrl(info.relayUrl)
      setSubscriptions(rows)
      const current = rows.find(row => row.type === 'ios_apns' && row.device_id === status.deviceId
        && row.bundle_id === status.bundleId && row.environment === status.environment)
      setDestinationId(current?.id ?? null)
      const problem = !status.available ? status.reason : !info.configured ? info.reason
        : info.bundleId !== status.bundleId ? 'The server APNs bundle ID does not match this iOS app.'
        : info.delivery === 'relay' && !status.relayAvailable ? 'Update the iOS app to enable verified relay notifications.' : null
      setReason(problem); setReady(!problem)
    } catch (error) {
      setReady(false)
      setReason(error instanceof Error ? error.message : 'Update the server and iOS app to enable native push notifications.')
    } finally { setChecked(true) }
  }, [])
  useEffect(() => {
    if (!enabled) return
    const onResume = () => {
      const appState = getIOSAppState()
      if (appState ? appState === 'active' : document.visibilityState !== 'hidden') void refresh()
    }
    void refresh()
    document.addEventListener('visibilitychange', onResume)
    const unsubscribeAppState = subscribeIOSAppState(state => { if (state === 'active') onResume() })
    return () => {
      document.removeEventListener('visibilitychange', onResume)
      unsubscribeAppState()
    }
  }, [enabled, refresh])

  const subscribe = useCallback(async () => {
    if (!ready) throw new Error(reason || 'Native push notifications are not configured yet.')
    const registration = await registerIOSPush(delivery, relayUrl)
    setPermission('granted')
    const destination = await pushApi.subscribeIOS(registration)
    setDestinationId(destination.id)
    setSubscriptions(rows => [destination, ...rows.filter(row => row.id !== destination.id)])
    return true
  }, [ready, reason, delivery, relayUrl])
  const unsubscribe = useCallback(async (id: string) => {
    await pushApi.unsubscribe(id)
    setSubscriptions(rows => rows.filter(row => row.id !== id))
    if (destinationId === id) setDestinationId(null)
  }, [destinationId])
  const unsubscribeAll = useCallback(async () => {
    // Keep failed deletions visible so the user can retry them.
    await Promise.all(subscriptions.map(row => unsubscribe(row.id)))
  }, [subscriptions, unsubscribe])
  const testPush = useCallback(async () => {
    if (!destinationId) throw new Error('Enable notifications on this iPhone first.')
    return pushApi.test(destinationId)
  }, [destinationId])

  return { isSupported: hasIOSNativeBridge(), supportChecked: checked,
    unsupportedReason: 'Update the Lumiverse iOS app to enable native push notifications.',
    registrationStatus: !checked ? 'pending' as const : ready ? 'ready' as const : 'error' as const,
    registrationReason: reason, registrationKind: 'native' as const, nativeTransportStatus: null,
    isSubscribed: destinationId !== null, permissionState: permission, subscriptions,
    subscribe, unsubscribe, unsubscribeAll, testPush, refresh }
}
