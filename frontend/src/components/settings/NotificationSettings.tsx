import { useState } from 'react'
import { Bell, BellOff, Smartphone, Trash2, Send, Shield } from 'lucide-react'
import { IconBellRinging } from '@tabler/icons-react'
import { useStore } from '@/store'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { Toggle } from '@/components/shared/Toggle'
import styles from './NotificationSettings.module.css'
import clsx from 'clsx'

export default function NotificationSettings() {
  const prefs = useStore((s) => s.pushNotificationPreferences)
  const setSetting = useStore((s) => s.setSetting)
  const addToast = useStore((s) => s.addToast)

  const {
    isSupported,
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
    setSubscribing(true)
    try {
      const ok = await subscribe()
      if (ok) {
        addToast({ type: 'success', message: 'Push notifications enabled for this device' })
      } else {
        addToast({ type: 'warning', message: 'Notification permission was denied' })
      }
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to subscribe' })
    } finally {
      setSubscribing(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const ok = await testPush()
      if (ok) {
        addToast({ type: 'info', message: 'Test notification sent' })
      } else {
        addToast({ type: 'warning', message: 'No subscriptions to send to' })
      }
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const handleUnsubscribeDevice = async (id: string) => {
    try {
      await unsubscribe(id)
      addToast({ type: 'info', message: 'Device removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove device' })
    }
  }

  if (!isSupported) {
    return (
      <div className={styles.container}>
        <div className={styles.unsupported}>
          <BellOff size={16} />
          <span>Push notifications are not supported in this browser.</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* ── Status Section ──────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Bell size={14} />
          <span>Push Status</span>
          <div className={styles.sectionHeaderActions}>
            {!isSubscribed ? (
              <button
                className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
                onClick={handleSubscribe}
                disabled={subscribing}
              >
                <IconBellRinging size={12} />
                {subscribing ? 'Subscribing...' : 'Enable'}
              </button>
            ) : (
              <>
                <button
                  className={styles.actionBtn}
                  onClick={handleTest}
                  disabled={testing}
                >
                  <Send size={12} />
                  {testing ? 'Sending...' : 'Test'}
                </button>
                <button
                  className={clsx(styles.actionBtn, styles.actionBtnDanger)}
                  onClick={unsubscribeAll}
                >
                  Unsubscribe All
                </button>
              </>
            )}
          </div>
        </div>
        <div className={styles.grid}>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Permission</span>
            <span className={styles.infoValue}>
              <span className={clsx(styles.statusDot, permissionState === 'granted' ? styles.statusActive : styles.statusInactive)} />
              {permissionState}
            </span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>This Device</span>
            <span className={styles.infoValue}>
              <span className={clsx(styles.statusDot, isSubscribed ? styles.statusActive : styles.statusInactive)} />
              {isSubscribed ? 'Subscribed' : 'Not subscribed'}
            </span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Total Devices</span>
            <span className={styles.infoValue}>{subscriptions.length}</span>
          </div>
        </div>
      </div>

      {/* ── Events Section ──────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Shield size={14} />
          <span>Notification Events</span>
        </div>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={prefs.enabled}
            onChange={(v) => updatePrefs({ enabled: v })}
            label="Enable push notifications"
            hint="Master toggle"
          />
        </div>
        <div className={clsx(styles.toggleRow, !prefs.enabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={prefs.events.generation_ended}
            onChange={(v) => updateEventPref('generation_ended', v)}
            disabled={!prefs.enabled}
            label="Generation completed"
            hint="When a character finishes responding"
          />
        </div>
        <div className={clsx(styles.toggleRow, !prefs.enabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={prefs.events.generation_error}
            onChange={(v) => updateEventPref('generation_error', v)}
            disabled={!prefs.enabled}
            label="Generation failed"
            hint="When a generation encounters an error"
          />
        </div>
      </div>

      {/* ── Devices Section ─────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Smartphone size={14} />
          <span>Registered Devices ({subscriptions.length})</span>
        </div>
        {subscriptions.length === 0 ? (
          <div className={styles.emptyRow}>No devices registered</div>
        ) : (
          subscriptions.map((sub) => (
            <div key={sub.id} className={styles.deviceRow}>
              <Smartphone size={13} className={styles.deviceIcon} />
              <span className={styles.deviceName}>{parseUserAgent(sub.user_agent)}</span>
              <span className={styles.deviceDate}>
                {new Date(sub.created_at * 1000).toLocaleDateString()}
              </span>
              <button
                className={styles.deviceRemove}
                onClick={() => handleUnsubscribeDevice(sub.id)}
                title="Remove device"
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

function parseUserAgent(ua: string): string {
  if (!ua) return 'Unknown device'
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'
  if (ua.includes('Edg')) return 'Edge'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
  return 'Browser'
}
