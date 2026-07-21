import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Copy, Check, RefreshCw, Server, Monitor, Bell, Send, Users } from 'lucide-react'
import { IconPlugConnected, IconStethoscope } from '@tabler/icons-react'
import { spinClass } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import { systemApi, type SystemInfo } from '@/api/system'
import { pushApi } from '@/api/push'
import { chatsApi } from '@/api/chats'
import { BASE_URL } from '@/api/client'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getPwaLifecycleDiagnostics } from '@/lib/pwaLifecycleDiagnostics'
import styles from './Diagnostics.module.css'
import clsx from 'clsx'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`
}

function getPlatformLabel(platform: string): string {
  switch (platform) {
    case 'linux': return 'Linux'
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'freebsd': return 'FreeBSD'
    default: return platform
  }
}

function detectBrowser(): string {
  const ua = navigator.userAgent
  if (ua.includes('Firefox/')) return `Firefox ${ua.split('Firefox/')[1]?.split(' ')[0]}`
  if (ua.includes('Edg/')) return `Edge ${ua.split('Edg/')[1]?.split(' ')[0]}`
  if (ua.includes('Chrome/')) return `Chrome ${ua.split('Chrome/')[1]?.split(' ')[0]}`
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return `Safari ${ua.split('Version/')[1]?.split(' ')[0] ?? ''}`
  return ua
}

function detectOS(): string {
  const ua = navigator.userAgent
  if (ua.includes('Win')) return 'Windows'
  if (ua.includes('Mac')) return 'macOS'
  if (ua.includes('Linux')) return 'Linux'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  return navigator.platform
}

const BROWSER_FEATURE_IDS = [
  'websocket',
  'serviceWorker',
  'webgl',
  'clipboard',
  'notifications',
  'sharedArrayBuffer',
] as const

const PWA_FEATURE_IDS = [
  'pushApi',
  'backgroundSync',
  'appBadge',
  'periodicSync',
] as const

type BrowserFeatureId = (typeof BROWSER_FEATURE_IDS)[number]
type PwaFeatureId = (typeof PWA_FEATURE_IDS)[number]

function checkFeatures(): Record<BrowserFeatureId, boolean> {
  return {
    websocket: typeof WebSocket !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    webgl: (() => { try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false } })(),
    clipboard: 'clipboard' in navigator,
    notifications: 'Notification' in window,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }
}

function checkPwaFeatures(): Record<PwaFeatureId, boolean> {
  return {
    pushApi: 'PushManager' in window,
    backgroundSync: 'SyncManager' in window,
    appBadge: 'setAppBadge' in navigator,
    periodicSync: 'PeriodicSyncManager' in window,
  }
}

function featureLabel(t: TFunction<'settings'>, id: BrowserFeatureId | PwaFeatureId): string {
  return t(`diagnostics.feature.${id}`)
}

function isSameHost(): boolean {
  const apiBase = BASE_URL
  if (apiBase.startsWith('/')) return true
  try {
    const apiUrl = new URL(apiBase, window.location.origin)
    return apiUrl.hostname === window.location.hostname
  } catch {
    return true
  }
}

function buildMarkdown(
  t: TFunction<'settings'>,
  backend: SystemInfo | null,
  backendError: string | null,
  extensions: { name: string; version: string; enabled: boolean }[],
): string {
  const lines: string[] = []

  lines.push(`## ${t('diagnostics.reportTitle')}`)
  lines.push('')

  lines.push(`### ${t('diagnostics.reportBackend')}`)
  if (backendError) {
    lines.push(`- **${t('diagnostics.reportStatus')}:** ${t('diagnostics.reportUnreachable', { error: backendError })}`)
  } else if (backend) {
    lines.push(`- **${t('diagnostics.version')}:** ${backend.backend.version}`)
    lines.push(`- **${t('diagnostics.branch')}:** ${backend.git.branch}`)
    lines.push(`- **${t('diagnostics.commit')}:** ${backend.git.commit}`)
    lines.push(`- **${t('diagnostics.runtime')}:** ${backend.backend.runtime}`)
    lines.push(`- **${t('diagnostics.os')}:** ${getPlatformLabel(backend.os.platform)} ${backend.os.release} (${backend.os.arch})`)
    lines.push(`- **${t('diagnostics.host')}:** ${backend.os.hostname}`)
    lines.push(`- **${t('diagnostics.cpu')}:** ${t('diagnostics.cpuCores', { model: backend.cpu.model, count: backend.cpu.cores })}`)
    lines.push(`- **${t('diagnostics.ram')}:** ${formatBytes(backend.memory.total - backend.memory.free)} / ${formatBytes(backend.memory.total)}`)
    if (backend.disk) {
      lines.push(`- **${t('diagnostics.storage')}:** ${formatBytes(backend.disk.used)} / ${formatBytes(backend.disk.total)}`)
    }
  }
  lines.push('')

  lines.push(`### ${t('diagnostics.reportFrontend')}`)
  lines.push(`- **${t('diagnostics.version')}:** ${__APP_VERSION__}`)
  lines.push(`- **${t('diagnostics.os')}:** ${detectOS()}`)
  lines.push(`- **${t('diagnostics.browser')}:** ${detectBrowser()}`)
  lines.push(`- **${t('diagnostics.sameHost')}:** ${isSameHost() ? t('diagnostics.yes') : t('diagnostics.no')}`)
  const features = checkFeatures()
  const unsupported = Object.entries(features).filter(([, v]) => !v).map(([k]) => featureLabel(t, k as BrowserFeatureId))
  if (unsupported.length > 0) {
    lines.push(`- **${t('diagnostics.reportUnsupportedFeatures')}:** ${unsupported.join(', ')}`)
  } else {
    lines.push(`- ${t('diagnostics.reportAllFeaturesSupported')}`)
  }
  lines.push('')

  lines.push(`### ${t('diagnostics.reportExtensions')}`)
  if (extensions.length > 0) {
    for (const ext of extensions) {
      const status = ext.enabled ? t('diagnostics.enabled') : t('diagnostics.disabled')
      lines.push(`- ${ext.name} v${ext.version} (${status})`)
    }
  } else {
    lines.push(`- ${t('diagnostics.reportNoExtensions')}`)
  }

  const lifecycle = getPwaLifecycleDiagnostics()
  if (lifecycle.length > 0) {
    lines.push('')
    lines.push('### PWA lifecycle (local-only, most recent 32 events)')
    for (const entry of lifecycle) {
      const details = Object.entries(entry.data)
        .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
        .join(', ')
      lines.push(`- ${entry.at} ${entry.event} [${details}]`)
    }
  }

  return lines.join('\n')
}

declare const __APP_VERSION__: string

export default function Diagnostics() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')

  const extensions = useStore((s) => s.extensions) ?? []
  const [backend, setBackend] = useState<SystemInfo | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const fetchInfo = useCallback(async () => {
    setLoading(true)
    setBackendError(null)
    try {
      const info = await systemApi.getInfo()
      setBackend(info)
    } catch (err: any) {
      setBackendError(err.message ?? t('diagnostics.connectFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { fetchInfo() }, [fetchInfo])

  const features = checkFeatures()
  const sameHost = isSameHost()

  const extList = extensions.map((e) => ({
    name: e.name,
    version: e.version,
    enabled: e.enabled,
  }))

  const handleCopy = useCallback(async () => {
    const md = buildMarkdown(t, backend, backendError, extList)
    await copyTextToClipboard(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [backend, backendError, extList, t])

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h3 className={styles.heading}>{t('diagnostics.title')}</h3>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={fetchInfo}
            disabled={loading}
            title={tc('actions.refresh')}
          >
            <RefreshCw size={14} className={loading ? spinClass : undefined} />
          </button>
          <button
            type="button"
            className={clsx(styles.copyBtn, copied && styles.copyBtnDone)}
            onClick={handleCopy}
          >
            {copied ? <><Check size={14} /> {t('diagnostics.copied')}</> : <><Copy size={14} /> {t('diagnostics.copyReport')}</>}
          </button>
        </div>
      </div>

      {/* Backend Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Server size={14} />
          <span>{t('diagnostics.backend')}</span>
        </div>
        {loading ? (
          <div className={styles.loadingRow}>{t('diagnostics.loading')}</div>
        ) : backendError ? (
          <div className={styles.errorRow}>{t('diagnostics.unreachable', { error: backendError })}</div>
        ) : backend && (
          <div className={styles.grid}>
            <InfoRow label={t('diagnostics.version')} value={backend.backend.version} />
            <InfoRow label={t('diagnostics.branch')} value={backend.git.branch} />
            <InfoRow label={t('diagnostics.commit')} value={backend.git.commit} />
            <InfoRow label={t('diagnostics.runtime')} value={backend.backend.runtime} />
            <InfoRow label={t('diagnostics.os')} value={`${getPlatformLabel(backend.os.platform)} ${backend.os.release} (${backend.os.arch})`} />
            <InfoRow label={t('diagnostics.host')} value={backend.os.hostname} />
            <InfoRow label={t('diagnostics.cpu')} value={t('diagnostics.cpuCores', { model: backend.cpu.model, count: backend.cpu.cores })} />
            <InfoRow label={t('diagnostics.ram')} value={`${formatBytes(backend.memory.total - backend.memory.free)} / ${formatBytes(backend.memory.total)}`} />
            {backend.disk && (
              <InfoRow label={t('diagnostics.storage')} value={`${formatBytes(backend.disk.used)} / ${formatBytes(backend.disk.total)}`} />
            )}
          </div>
        )}
      </div>

      {/* Frontend Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Monitor size={14} />
          <span>{t('diagnostics.frontend')}</span>
        </div>
        <div className={styles.grid}>
          <InfoRow label={t('diagnostics.version')} value={__APP_VERSION__} />
          <InfoRow label={t('diagnostics.os')} value={detectOS()} />
          <InfoRow label={t('diagnostics.browser')} value={detectBrowser()} />
          <InfoRow label={t('diagnostics.sameHost')} value={sameHost ? t('diagnostics.yes') : t('diagnostics.no')} />
          <div className={styles.featureRow}>
            <span className={styles.featureLabel}>{t('diagnostics.browserFeatures')}</span>
            <div className={styles.featureTags}>
              {Object.entries(features).map(([id, supported]) => (
                <span key={id} className={clsx(styles.featureTag, supported ? styles.featureOk : styles.featureMissing)}>
                  {featureLabel(t, id as BrowserFeatureId)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* PWA Capabilities Section */}
      <PwaCapabilitiesSection />

      {/* Data Maintenance Section */}
      <DataMaintenanceSection />

      {/* Extensions Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <IconPlugConnected size={14} />
          <span>{t('diagnostics.extensionsCount', { count: extensions.length })}</span>
        </div>
        {extensions.length === 0 ? (
          <div className={styles.emptyRow}>{t('diagnostics.noExtensions')}</div>
        ) : (
          <div className={styles.extList}>
            {extensions.map((ext) => (
              <div key={ext.id} className={styles.extRow}>
                <span className={styles.extName}>{ext.name}</span>
                <span className={styles.extVersion}>v{ext.version}</span>
                <span className={clsx(styles.extStatus, ext.enabled ? styles.extEnabled : styles.extDisabled)}>
                  {ext.enabled ? t('diagnostics.enabled') : t('diagnostics.disabled')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DataMaintenanceSection() {
  const { t } = useTranslation('settings')
  const addToast = useStore((s) => s.addToast)
  const [reattributing, setReattributing] = useState(false)
  const [reattributeResult, setReattributeResult] = useState<string | null>(null)

  const handleReattributeAll = useCallback(async () => {
    setReattributing(true)
    setReattributeResult(null)
    try {
      const result = await chatsApi.reattributeAll()
      if (result.messages_updated === 0) {
        setReattributeResult(t('diagnostics.noUnattributed'))
      } else {
        setReattributeResult(t('diagnostics.reattributeResult', {
          messages: result.messages_updated,
          chats: result.chats_updated,
        }))
      }
      addToast({
        type: result.messages_updated > 0 ? 'success' : 'info',
        message: result.messages_updated > 0
          ? t('diagnostics.reattributeToast', {
            messages: result.messages_updated,
            chats: result.chats_updated,
          })
          : t('diagnostics.reattributeToastNone'),
      })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || t('diagnostics.reattributeFailed') })
    } finally {
      setReattributing(false)
    }
  }, [addToast, t])

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <IconStethoscope size={14} />
        <span>{t('diagnostics.dataMaintenance')}</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.maintenanceRow}>
          <div className={styles.maintenanceDesc}>
            <Users size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
            {t('diagnostics.reattributeDesc')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {reattributeResult && <span className={styles.maintenanceResult}>{reattributeResult}</span>}
            <button
              type="button"
              className={styles.copyBtn}
              onClick={handleReattributeAll}
              disabled={reattributing}
            >
              <Users size={12} />
              {reattributing ? t('diagnostics.working') : t('diagnostics.reattribute')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PwaCapabilitiesSection() {
  const { t } = useTranslation('settings')
  const addToast = useStore((s) => s.addToast)
  const pwaFeatures = checkPwaFeatures()
  const {
    isSupported,
    supportChecked,
    unsupportedReason,
    registrationStatus,
    registrationReason,
  } = usePushSubscription()
  const [countdown, setCountdown] = useState<number | null>(null)
  const [sending, setSending] = useState(false)

  const describeTestFailure = useCallback((reason?: 'no_subscriptions' | 'disabled' | 'event_disabled' | 'user_active') => {
    if (reason === 'disabled') return t('diagnostics.pushDisabled')
    if (reason === 'event_disabled') return t('diagnostics.pushEventDisabled')
    if (reason === 'user_active') return t('diagnostics.pushUserActive')
    return t('diagnostics.pushNoSubscriptions')
  }, [t])

  const pushRegistrationLabel = (status: 'ready' | 'pending' | 'missing' | 'error') => {
    if (status === 'ready') return t('diagnostics.swReady')
    if (status === 'pending') return t('diagnostics.swActivating')
    if (status === 'missing') return t('diagnostics.missing')
    return t('diagnostics.swError')
  }

  const handleDelayedPush = useCallback(async () => {
    setSending(true)
    setCountdown(10)

    // Countdown timer
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval)
          return null
        }
        return prev - 1
      })
    }, 1000)

    // Send the push after 10 seconds
    setTimeout(async () => {
      try {
        const result = await pushApi.test()
        if (!result.success) {
          addToast({ type: 'warning', message: describeTestFailure(result.reason) })
        }
      } catch (err: any) {
        addToast({ type: 'error', message: err.message || t('diagnostics.pushTestFailed') })
      } finally {
        setSending(false)
      }
    }, 10_000)
  }, [addToast, describeTestFailure, t])

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <Bell size={14} />
        <span>{t('diagnostics.pwaCapabilities')}</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.featureRow}>
          <span className={styles.featureLabel}>{t('diagnostics.swApis')}</span>
          <div className={styles.featureTags}>
            {Object.entries(pwaFeatures).map(([id, supported]) => (
              <span key={id} className={clsx(styles.featureTag, supported ? styles.featureOk : styles.featureMissing)}>
                {featureLabel(t, id as PwaFeatureId)}
              </span>
            ))}
          </div>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.notificationPermission')}</span>
          <span className={styles.infoValue}>
            {typeof Notification !== 'undefined' ? Notification.permission : t('diagnostics.unsupported')}
          </span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.pushRegistration')}</span>
          <span className={styles.infoValue}>
            {supportChecked
              ? (isSupported ? t('diagnostics.available') : (unsupportedReason || t('diagnostics.unavailable')))
              : t('diagnostics.checking')}
          </span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.swRegistrationState')}</span>
          <span className={styles.infoValue}>{pushRegistrationLabel(registrationStatus)}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.secureContext')}</span>
          <span className={styles.infoValue}>{window.isSecureContext ? t('diagnostics.yes') : t('diagnostics.no')}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.swController')}</span>
          <span className={styles.infoValue}>{navigator.serviceWorker?.controller ? t('diagnostics.present') : t('diagnostics.missing')}</span>
        </div>
        {registrationReason && registrationStatus !== 'ready' && (
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{t('diagnostics.swDetail')}</span>
            <span className={styles.infoValue}>{registrationReason}</span>
          </div>
        )}
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('diagnostics.delayedPushTest')}</span>
          <span className={styles.infoValue}>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={handleDelayedPush}
              disabled={sending}
            >
              <Send size={12} />
              {countdown !== null ? t('diagnostics.sendingIn', { count: countdown }) : t('diagnostics.autoPushIn10s')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  )
}
