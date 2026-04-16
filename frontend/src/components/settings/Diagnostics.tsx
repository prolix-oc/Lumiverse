import { useEffect, useState, useCallback } from 'react'
import { Copy, Check, RefreshCw, Server, Monitor, Bell, Send, Users } from 'lucide-react'
import { IconPlugConnected, IconStethoscope } from '@tabler/icons-react'
import { spinClass } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import { systemApi, type SystemInfo } from '@/api/system'
import { pushApi } from '@/api/push'
import { chatsApi } from '@/api/chats'
import { BASE_URL } from '@/api/client'
import { copyTextToClipboard } from '@/lib/clipboard'
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

function checkFeatures(): Record<string, boolean> {
  return {
    'WebSocket': typeof WebSocket !== 'undefined',
    'Service Worker': 'serviceWorker' in navigator,
    'WebGL': (() => { try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false } })(),
    'Clipboard API': 'clipboard' in navigator,
    'Notifications': 'Notification' in window,
    'SharedArrayBuffer': typeof SharedArrayBuffer !== 'undefined',
  }
}

function checkPwaFeatures(): Record<string, boolean> {
  return {
    'Push API': 'PushManager' in window,
    'Background Sync': 'SyncManager' in window,
    'App Badge': 'setAppBadge' in navigator,
    'Periodic Sync': 'PeriodicSyncManager' in window,
  }
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

function buildMarkdown(backend: SystemInfo | null, backendError: string | null, extensions: { name: string; version: string; enabled: boolean }[]): string {
  const lines: string[] = []

  lines.push('## Diagnostics Report')
  lines.push('')

  // Backend
  lines.push('### Backend')
  if (backendError) {
    lines.push(`- **Status:** Unreachable (${backendError})`)
  } else if (backend) {
    lines.push(`- **Version:** ${backend.backend.version}`)
    lines.push(`- **Branch:** ${backend.git.branch}`)
    lines.push(`- **Commit:** ${backend.git.commit}`)
    lines.push(`- **Runtime:** ${backend.backend.runtime}`)
    lines.push(`- **OS:** ${getPlatformLabel(backend.os.platform)} ${backend.os.release} (${backend.os.arch})`)
    lines.push(`- **Host:** ${backend.os.hostname}`)
    lines.push(`- **CPU:** ${backend.cpu.model} (${backend.cpu.cores} cores)`)
    lines.push(`- **RAM:** ${formatBytes(backend.memory.total - backend.memory.free)} used / ${formatBytes(backend.memory.total)} total`)
    if (backend.disk) {
      lines.push(`- **Storage:** ${formatBytes(backend.disk.used)} used / ${formatBytes(backend.disk.total)} total`)
    }
  }
  lines.push('')

  // Frontend
  lines.push('### Frontend')
  lines.push(`- **Version:** ${__APP_VERSION__}`)
  lines.push(`- **OS:** ${detectOS()}`)
  lines.push(`- **Browser:** ${detectBrowser()}`)
  lines.push(`- **Same Host:** ${isSameHost() ? 'Yes' : 'No'}`)
  const features = checkFeatures()
  const supported = Object.entries(features).filter(([, v]) => v).map(([k]) => k)
  const unsupported = Object.entries(features).filter(([, v]) => !v).map(([k]) => k)
  if (unsupported.length > 0) {
    lines.push(`- **Unsupported Features:** ${unsupported.join(', ')}`)
  } else {
    lines.push(`- **Browser Features:** All supported`)
  }
  lines.push('')

  // Extensions
  if (extensions.length > 0) {
    lines.push('### Extensions')
    for (const ext of extensions) {
      const status = ext.enabled ? 'enabled' : 'disabled'
      lines.push(`- ${ext.name} v${ext.version} (${status})`)
    }
  } else {
    lines.push('### Extensions')
    lines.push('- None installed')
  }

  return lines.join('\n')
}

declare const __APP_VERSION__: string

export default function Diagnostics() {
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
      setBackendError(err.message ?? 'Failed to connect')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchInfo() }, [fetchInfo])

  const features = checkFeatures()
  const sameHost = isSameHost()

  const extList = extensions.map((e) => ({
    name: e.name,
    version: e.version,
    enabled: e.enabled,
  }))

  const handleCopy = useCallback(async () => {
    const md = buildMarkdown(backend, backendError, extList)
    await copyTextToClipboard(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [backend, backendError, extList])

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h3 className={styles.heading}>Diagnostics</h3>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={fetchInfo}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? spinClass : undefined} />
          </button>
          <button
            type="button"
            className={clsx(styles.copyBtn, copied && styles.copyBtnDone)}
            onClick={handleCopy}
          >
            {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy Report</>}
          </button>
        </div>
      </div>

      {/* Backend Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Server size={14} />
          <span>Backend</span>
        </div>
        {loading ? (
          <div className={styles.loadingRow}>Loading...</div>
        ) : backendError ? (
          <div className={styles.errorRow}>Unreachable: {backendError}</div>
        ) : backend && (
          <div className={styles.grid}>
            <InfoRow label="Version" value={backend.backend.version} />
            <InfoRow label="Branch" value={backend.git.branch} />
            <InfoRow label="Commit" value={backend.git.commit} />
            <InfoRow label="Runtime" value={backend.backend.runtime} />
            <InfoRow label="OS" value={`${getPlatformLabel(backend.os.platform)} ${backend.os.release} (${backend.os.arch})`} />
            <InfoRow label="Host" value={backend.os.hostname} />
            <InfoRow label="CPU" value={`${backend.cpu.model} (${backend.cpu.cores} cores)`} />
            <InfoRow label="RAM" value={`${formatBytes(backend.memory.total - backend.memory.free)} / ${formatBytes(backend.memory.total)}`} />
            {backend.disk && (
              <InfoRow label="Storage" value={`${formatBytes(backend.disk.used)} / ${formatBytes(backend.disk.total)}`} />
            )}
          </div>
        )}
      </div>

      {/* Frontend Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Monitor size={14} />
          <span>Frontend</span>
        </div>
        <div className={styles.grid}>
          <InfoRow label="Version" value={__APP_VERSION__} />
          <InfoRow label="OS" value={detectOS()} />
          <InfoRow label="Browser" value={detectBrowser()} />
          <InfoRow label="Same Host" value={sameHost ? 'Yes' : 'No'} />
          <div className={styles.featureRow}>
            <span className={styles.featureLabel}>Browser Features</span>
            <div className={styles.featureTags}>
              {Object.entries(features).map(([name, supported]) => (
                <span key={name} className={clsx(styles.featureTag, supported ? styles.featureOk : styles.featureMissing)}>
                  {name}
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
          <span>Extensions ({extensions.length})</span>
        </div>
        {extensions.length === 0 ? (
          <div className={styles.emptyRow}>No extensions installed</div>
        ) : (
          <div className={styles.extList}>
            {extensions.map((ext) => (
              <div key={ext.id} className={styles.extRow}>
                <span className={styles.extName}>{ext.name}</span>
                <span className={styles.extVersion}>v{ext.version}</span>
                <span className={clsx(styles.extStatus, ext.enabled ? styles.extEnabled : styles.extDisabled)}>
                  {ext.enabled ? 'Enabled' : 'Disabled'}
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
  const addToast = useStore((s) => s.addToast)
  const [reattributing, setReattributing] = useState(false)
  const [reattributeResult, setReattributeResult] = useState<string | null>(null)

  const handleReattributeAll = useCallback(async () => {
    setReattributing(true)
    setReattributeResult(null)
    try {
      const result = await chatsApi.reattributeAll()
      if (result.messages_updated === 0) {
        setReattributeResult('No unattributed messages found')
      } else {
        setReattributeResult(`${result.messages_updated} messages across ${result.chats_updated} chats`)
      }
      addToast({
        type: result.messages_updated > 0 ? 'success' : 'info',
        message: result.messages_updated > 0
          ? `Reattributed ${result.messages_updated} messages across ${result.chats_updated} chats`
          : 'All user messages are already attributed to personas',
      })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Reattribution failed' })
    } finally {
      setReattributing(false)
    }
  }, [addToast])

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <IconStethoscope size={14} />
        <span>Data Maintenance</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.maintenanceRow}>
          <div className={styles.maintenanceDesc}>
            <Users size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
            Match user messages to persona avatars by name. Useful for chats imported from SillyTavern.
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
              {reattributing ? 'Working...' : 'Reattribute'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PwaCapabilitiesSection() {
  const addToast = useStore((s) => s.addToast)
  const pwaFeatures = checkPwaFeatures()
  const [countdown, setCountdown] = useState<number | null>(null)
  const [sending, setSending] = useState(false)

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
          addToast({ type: 'warning', message: 'No push subscriptions found. Subscribe in Notifications settings first.' })
        }
      } catch (err: any) {
        addToast({ type: 'error', message: err.message || 'Push test failed' })
      } finally {
        setSending(false)
      }
    }, 10_000)
  }, [addToast])

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <Bell size={14} />
        <span>PWA Capabilities</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.featureRow}>
          <span className={styles.featureLabel}>Service Worker APIs</span>
          <div className={styles.featureTags}>
            {Object.entries(pwaFeatures).map(([name, supported]) => (
              <span key={name} className={clsx(styles.featureTag, supported ? styles.featureOk : styles.featureMissing)}>
                {name}
              </span>
            ))}
          </div>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>Notification Permission</span>
          <span className={styles.infoValue}>
            {typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'}
          </span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>Delayed Push Test</span>
          <span className={styles.infoValue}>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={handleDelayedPush}
              disabled={sending}
            >
              <Send size={12} />
              {countdown !== null ? `Sending in ${countdown}s...` : 'Send in 10s'}
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
