import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, Smartphone, Trash2, Send, Shield } from 'lucide-react'
import { IconBellRinging } from '@tabler/icons-react'
import { useStore } from '@/store'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { Toggle } from '@/components/shared/Toggle'
import styles from './NotificationSettings.module.css'
import clsx from 'clsx'

export default function NotificationSettings() {
  const { t } = useTranslation('settings')
  const prefs = useStore((s) => s.pushNotificationPreferences)
  const setSetting = useStore((s) => s.setSetting)
  const addToast = useStore((s) => s.addToast)

  const {
    isSupported,
    supportChecked,
    unsupportedReason,
    registrationStatus,
    registrationReason,
    isSubscribed,
    permissionState,
    subscriptions,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    testPush,
  } = usePushSubscription()

  const [subscribing, setSubscribing] = useState(false)
  const [testing, setTesting] = useState(false)

  const describeTestFailure = (reason?: 'no_subscriptions' | 'disabled' | 'event_disabled' | 'user_active') => {
    if (reason === 'disabled') return t('notifications.failDisabled')
    if (reason === 'event_disabled') return t('notifications.failEventDisabled')
    if (reason === 'user_active') return t('notifications.failUserActive')
    return t('notifications.failNoSubscriptions')
  }

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    setSetting('pushNotificationPreferences', { ...prefs, ...patch })
  }

  const updateEventPref = (key: keyof typeof prefs.events, value: boolean) => {
    setSetting('pushNotificationPreferences', {
      ...prefs,
      events: { ...prefs.events, [key]: value },
    })
  }

  const handleSubscribe = async () => {
    // Start the browser permission request before any React state update. Safari
    // web apps are strict about preserving transient user activation for prompts.
    const subscribeAttempt = subscribe()
    setSubscribing(true)
    try {
      const ok = await subscribeAttempt
      if (ok) {
        addToast({ type: 'success', message: t('notifications.toastEnabled') })
      } else {
        addToast({ type: 'warning', message: t('notifications.toastDenied') })
      }
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || t('notifications.toastSubscribeFailed') })
    } finally {
      setSubscribing(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const result = await testPush()
      if (result.success) {
        addToast({ type: 'info', message: t('notifications.toastTestSent') })
      } else {
        addToast({ type: 'warning', message: describeTestFailure(result.reason) })
      }
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || t('notifications.toastTestFailed') })
    } finally {
      setTesting(false)
    }
  }

  const handleUnsubscribeDevice = async (id: string) => {
    try {
      await unsubscribe(id)
      addToast({ type: 'info', message: t('notifications.toastDeviceRemoved') })
    } catch {
      addToast({ type: 'error', message: t('notifications.toastRemoveFailed') })
    }
  }

  if (!isSupported) {
    return (
      <div className={styles.container}>
        <div className={styles.unsupported}>
          <BellOff size={16} />
          <span>
            {supportChecked
              ? (unsupportedReason || t('notifications.unsupported'))
              : t('notifications.checking')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Bell size={14} />
          <span>{t('notifications.pushStatus')}</span>
          <div className={styles.sectionHeaderActions}>
            {!isSubscribed ? (
              <button
                className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
                onClick={handleSubscribe}
                disabled={subscribing}
              >
                <IconBellRinging size={12} />
                {subscribing ? t('notifications.subscribing') : t('notifications.enable')}
              </button>
            ) : (
              <>
                <button
                  className={styles.actionBtn}
                  onClick={handleTest}
                  disabled={testing}
                >
                  <Send size={12} />
                  {testing ? t('notifications.sending') : t('notifications.test')}
                </button>
                <button
                  className={clsx(styles.actionBtn, styles.actionBtnDanger)}
                  onClick={unsubscribeAll}
                >
                  {t('notifications.unsubscribeAll')}
                </button>
              </>
            )}
          </div>
        </div>
        <div className={styles.grid}>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{t('notifications.permission')}</span>
            <span className={styles.infoValue}>
              <span className={clsx(styles.statusDot, permissionState === 'granted' ? styles.statusActive : styles.statusInactive)} />
              {permissionState}
            </span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{t('notifications.thisDevice')}</span>
            <span className={styles.infoValue}>
              <span className={clsx(styles.statusDot, isSubscribed ? styles.statusActive : styles.statusInactive)} />
              {isSubscribed ? t('notifications.subscribed') : t('notifications.notSubscribed')}
            </span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{t('notifications.serviceWorker')}</span>
            <span className={styles.infoValue}>
              <span className={clsx(styles.statusDot, registrationStatus === 'ready' ? styles.statusActive : styles.statusInactive)} />
              {describeRegistrationStatus(registrationStatus, t)}
            </span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{t('notifications.totalDevices')}</span>
            <span className={styles.infoValue}>{subscriptions.length}</span>
          </div>
        </div>
        {registrationReason && registrationStatus !== 'ready' && (
          <div className={styles.emptyRow}>{registrationReason}</div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Shield size={14} />
          <span>{t('notifications.eventsTitle')}</span>
        </div>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={prefs.enabled}
            onChange={(v) => updatePrefs({ enabled: v })}
            label={t('notifications.enablePush')}
            hint={t('notifications.enablePushHint')}
          />
        </div>
        <div className={clsx(styles.toggleRow, !prefs.enabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={prefs.events.generation_ended}
            onChange={(v) => updateEventPref('generation_ended', v)}
            disabled={!prefs.enabled}
            label={t('notifications.generationCompleted')}
            hint={t('notifications.generationCompletedHint')}
          />
        </div>
        <div className={clsx(styles.toggleRow, !prefs.enabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={prefs.events.generation_error}
            onChange={(v) => updateEventPref('generation_error', v)}
            disabled={!prefs.enabled}
            label={t('notifications.generationFailed')}
            hint={t('notifications.generationFailedHint')}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Smartphone size={14} />
          <span>{t('notifications.devicesTitle', { count: subscriptions.length })}</span>
        </div>
        {subscriptions.length === 0 ? (
          <div className={styles.emptyRow}>{t('notifications.noDevices')}</div>
        ) : (
          subscriptions.map((sub) => (
            <div key={sub.id} className={styles.deviceRow}>
              <Smartphone size={13} className={styles.deviceIcon} />
              <span className={styles.deviceName}>{parseUserAgent(sub.user_agent, t)}</span>
              <span className={styles.deviceDate}>
                {new Date(sub.created_at * 1000).toLocaleDateString()}
              </span>
              <button
                className={styles.deviceRemove}
                onClick={() => handleUnsubscribeDevice(sub.id)}
                title={t('notifications.removeDevice')}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function parseUserAgent(ua: string, t: (key: string) => string): string {
  if (!ua) return t('notifications.unknownDevice')
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'
  if (ua.includes('Edg')) return 'Edge'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
  return 'Browser'
}

function describeRegistrationStatus(
  status: 'ready' | 'pending' | 'missing' | 'error',
  t: (key: string) => string,
): string {
  if (status === 'ready') return t('notifications.regReady')
  if (status === 'pending') return t('notifications.regActivating')
  if (status === 'missing') return t('notifications.regMissing')
  return t('notifications.regError')
}
