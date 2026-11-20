import { useCallback, useEffect, useState, useRef } from 'react'
import { pushApi, type PushSubscriptionRecord } from '@/api/push'
import { androidNativeRequest, clearAndroidEnrollment, getAndroidNotificationStatus, hasAndroidNativeBridge, registerAndroidPush,
  androidRegistrationReason, type AndroidNotificationInfo, type AndroidNotificationStatus } from '@/lib/android-native'

export function useAndroidPushSubscription(enabled: boolean) {
  const [info, setInfo] = useState<AndroidNotificationInfo | null>(null)
  const enrolling = useRef<AbortController | null>(null)
  useEffect(() => () => { enrolling.current?.abort() }, [])
  const [checked, setChecked] = useState(false)
  const [status, setStatus] = useState<AndroidNotificationStatus | null>(null)
  const [rows, setRows] = useState<PushSubscriptionRecord[]>([])
  const [destinationId, setDestinationId] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const current = await getAndroidNotificationStatus()
      const [info, destinations] = await Promise.all([pushApi.getAndroidInfo(), pushApi.listSubscriptions()])
      setStatus(current); setInfo(info); setRows(destinations)
      const enrollment = current.enrollment
      setDestinationId(enrollment && enrollment.serverOrigin === window.location.origin && enrollment.serverInstanceId === info.serverInstanceId
        && destinations.some(row => row.type === 'android_native' && row.id === enrollment.destinationId && row.device_id === current.deviceId)
        ? enrollment.destinationId : null)
      setReason(androidRegistrationReason(current, info))
    } catch (error) { setReason(error instanceof Error ? error.message : 'Native notification setup failed.') }
    finally { setChecked(true) }
  }, [])
  useEffect(() => {
    if (!enabled) return
    void refresh()
    const resume = () => { if (document.visibilityState !== 'hidden') void refresh() }
    window.addEventListener('lumiverse:android-resume', resume)
    document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('lumiverse:android-resume', resume); document.removeEventListener('visibilitychange', resume) }
  }, [enabled, refresh])
  const subscribe = useCallback(async () => {
    if (reason) throw new Error(reason)
    enrolling.current?.abort()
    const controller = new AbortController(); enrolling.current = controller
    const registration = await registerAndroidPush(info ?? undefined, controller.signal)
    if (!registration) { await refresh(); return false }
    try {
      const enrollment = await pushApi.subscribeAndroid(registration, { signal: controller.signal })
      try {
        if (controller.signal.aborted) throw new DOMException('Enrollment cancelled', 'AbortError')
        await androidNativeRequest('notifications.save', { ...enrollment, enrollmentId: registration.enrollmentId, deviceToken: registration.deviceToken, accountId: registration.accountId ?? enrollment.destination.user_id, serverOrigin: window.location.origin })
      } catch (error) { await pushApi.unsubscribe(enrollment.destination.id).catch(() => {}); throw error }
    } catch (error) {
      if (registration.enrollmentId) await androidNativeRequest('notifications.cancel', { enrollmentId: registration.enrollmentId }).catch(() => {})
      throw error
    } finally { if (enrolling.current === controller) enrolling.current = null }
    await refresh()
    return true
  }, [reason, info, refresh])
  const unsubscribe = useCallback(async (id: string) => {
    await pushApi.unsubscribe(id)
    if (id === destinationId) { await clearAndroidEnrollment(id); setDestinationId(null) }
    setRows(previous => previous.filter(row => row.id !== id))
  }, [destinationId])
  const unsubscribeAll = useCallback(async () => { await Promise.all(rows.map(row => unsubscribe(row.id))) }, [rows, unsubscribe])
  const testPush = useCallback(async () => {
    if (!destinationId) throw new Error('Enable notifications on this Android device first.')
    if (status?.transport === 'local' && !(await getAndroidNotificationStatus()).connected)
      throw new Error('The native notification connection is still starting. Try again in a moment.')
    return pushApi.test(destinationId)
  }, [destinationId, status?.transport])
  return { isSupported: hasAndroidNativeBridge(), supportChecked: checked,
    unsupportedReason: 'Update the Lumiverse Android app to enable native notifications.',
    registrationStatus: !checked ? 'pending' as const : reason ? 'error' as const : 'ready' as const,
    registrationReason: reason, registrationKind: 'native' as const, nativeTransportStatus: null,
    isSubscribed: !!destinationId, permissionState: status?.permission ?? 'default' as NotificationPermission,
    subscriptions: rows, subscribe, unsubscribe, unsubscribeAll, testPush, refresh }
}
