import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  Download,
  GitBranch,
  Power,
  PowerOff,
  Wifi,
  WifiOff,
  Trash2,
  Loader2,
  HardDrive,
  PackageCheck,
  Hammer,
  Globe,
  Plus,
  X,
} from 'lucide-react'
import { Toggle } from '@/components/shared/Toggle'
import NumericInput from '@/components/shared/NumericInput'
import { spinClass } from '@/components/shared/Spinner'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useStore } from '@/store'
import {
  type DatabaseMaintenanceSettings,
  operatorApi,
  type DatabaseTuningSettings,
  type DnsSettings,
  type OperatorDatabaseStatus,
  type OperatorDnsStatus,
  type OperatorSharpStatus,
  type OperatorStatus,
  type SharpSettings,
  type TrustedHostEntry,
  type TrustedHostsResponse,
} from '@/api/operator'
import { settingsApi } from '@/api/settings'
import { embeddingsApi, type VectorStoreHealth } from '@/api/embeddings'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import styles from './OperatorPanel.module.css'
import clsx from 'clsx'

const OPERATOR_OPERATION_LABELS: Record<string, string> = {
  update: 'updating',
  updating: 'updating',
  'branch-switch': 'switching branch',
  'switching branch': 'switching branch',
  restart: 'restarting',
  restarting: 'restarting',
  'remote-toggle': 'toggling remote',
  'toggling remote': 'toggling remote',
  rebuild: 'rebuilding frontend',
  'rebuilding frontend': 'rebuilding frontend',
  'clear-cache': 'clearing cache',
  'clearing cache': 'clearing cache',
  'ensure-deps': 'installing dependencies',
  'installing dependencies': 'installing dependencies',
  'database-maintenance': 'database maintenance',
  'database maintenance': 'database maintenance',
}

/** Operations that cause the server to restart and require reconnection handling. */
const RESTART_OPERATIONS = new Set(['updating', 'switching branch', 'restarting', 'toggling remote', 'rebuilding frontend'])

function normalizeOperatorOperation(operation: string | null | undefined): string | null {
  if (!operation) return null
  return OPERATOR_OPERATION_LABELS[operation] ?? operation
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hostSourceKey(source: TrustedHostEntry['source']): string {
  const keys: Record<TrustedHostEntry['source'], string> = {
    hostname: 'operator.hostSourceHostname',
    mdns: 'operator.hostSourceMdns',
    'reverse-dns': 'operator.hostSourceReverseDns',
    tailscale: 'operator.hostSourceTailscale',
    'lan-ip': 'operator.hostSourceLanIp',
    env: 'operator.hostSourceEnv',
    configured: 'operator.hostSourceConfigured',
  }
  return keys[source] ?? source
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatLogTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function normalizeDatabaseTuning(input: DatabaseTuningSettings): DatabaseTuningSettings {
  const cacheMemoryPercent = input.cacheMemoryPercent == null || !Number.isFinite(input.cacheMemoryPercent) || input.cacheMemoryPercent === 0
    ? null
    : Math.max(0.1, Math.min(50, input.cacheMemoryPercent))
  const mmapSizeBytes = input.mmapSizeBytes == null || !Number.isFinite(input.mmapSizeBytes) || input.mmapSizeBytes < 0
    ? null
    : Math.floor(input.mmapSizeBytes)
  return { cacheMemoryPercent, mmapSizeBytes }
}

function normalizeDatabaseMaintenance(input: DatabaseMaintenanceSettings): DatabaseMaintenanceSettings {
  return {
    optimizeIntervalHours: input.optimizeIntervalHours == null || !Number.isFinite(input.optimizeIntervalHours)
      ? null
      : Math.max(1, Math.floor(input.optimizeIntervalHours)),
    analyzeIntervalHours: input.analyzeIntervalHours == null || !Number.isFinite(input.analyzeIntervalHours)
      ? null
      : Math.max(1, Math.floor(input.analyzeIntervalHours)),
    autoVacuumEnabled: !!input.autoVacuumEnabled,
    vacuumIntervalHours: input.vacuumIntervalHours == null || !Number.isFinite(input.vacuumIntervalHours)
      ? null
      : Math.max(1, Math.floor(input.vacuumIntervalHours)),
    vacuumMinIdleMinutes: input.vacuumMinIdleMinutes == null || !Number.isFinite(input.vacuumMinIdleMinutes)
      ? 15
      : Math.max(1, Math.floor(input.vacuumMinIdleMinutes)),
    vacuumRequireNoVisibleClients: input.vacuumRequireNoVisibleClients !== false,
    vacuumRequireNoActiveGenerations: input.vacuumRequireNoActiveGenerations !== false,
    vacuumMinReclaimBytes: input.vacuumMinReclaimBytes == null || !Number.isFinite(input.vacuumMinReclaimBytes)
      ? 256 * 1024 * 1024
      : Math.max(0, Math.floor(input.vacuumMinReclaimBytes)),
    vacuumMinReclaimPercent: input.vacuumMinReclaimPercent == null || !Number.isFinite(input.vacuumMinReclaimPercent)
      ? 15
      : Math.max(0, Math.min(100, input.vacuumMinReclaimPercent)),
    vacuumMinDbSizeBytes: input.vacuumMinDbSizeBytes == null || !Number.isFinite(input.vacuumMinDbSizeBytes)
      ? 1024 * 1024 * 1024
      : Math.max(0, Math.floor(input.vacuumMinDbSizeBytes)),
    vacuumCheckpointMode: input.vacuumCheckpointMode ?? 'TRUNCATE',
  }
}

function normalizeSharpSettings(input: SharpSettings): SharpSettings {
  const normalizeInt = (value: number | null | undefined, min: number, max: number) => {
    if (value == null || !Number.isFinite(value)) return null
    return Math.max(min, Math.min(max, Math.floor(value)))
  }

  return {
    concurrency: normalizeInt(input.concurrency, 1, 16),
    cacheMemoryMb: normalizeInt(input.cacheMemoryMb, 8, 512),
    cacheFiles: normalizeInt(input.cacheFiles, 0, 2048),
    cacheItems: normalizeInt(input.cacheItems, 1, 4096),
  }
}

// ─── Confirmation state ─────────────────────────────────────────────────────

interface ConfirmState {
  title: string
  message: string | React.ReactNode
  variant: 'danger' | 'warning' | 'safe'
  confirmText: string
  onConfirm: () => void
}

// ─── Log Viewer ─────────────────────────────────────────────────────────────

function LogViewer() {
  const { t } = useTranslation('settings')
  const logs = useStore((s) => s.operatorLogs)
  const clearLogs = useStore((s) => s.clearOperatorLogs)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [bufferSize, setBufferSize] = useState(() =>
    parseInt(localStorage.getItem('operator_log_buffer_size') || '150', 10) || 150
  )

  // Subscribe to log streaming on mount
  useEffect(() => {
    operatorApi.subscribeLogs().catch(() => {})
    // Load initial logs
    operatorApi.getLogs(bufferSize).then((res) => {
      if (res?.entries?.length) {
        useStore.getState().appendOperatorLogs(res.entries)
      }
    }).catch(() => {})

    return () => {
      operatorApi.unsubscribeLogs().catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    // Re-enable auto-scroll when near bottom
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }, [])

  const handleBufferChange = useCallback((val: string) => {
    const num = Math.max(50, Math.min(2000, parseInt(val, 10) || 150))
    setBufferSize(num)
    localStorage.setItem('operator_log_buffer_size', String(num))
  }, [])

  return (
    <>
      <div className={styles.logContainer}>
        <div ref={scrollRef} className={styles.logScroll} onScroll={handleScroll}>
          {logs.length === 0 ? (
            <div className={styles.logEmpty}>{t('operator.logsEmpty')}</div>
          ) : (
            logs.map((entry, i) => (
              <div key={i} className={styles.logEntry}>
                <span className={styles.logTimestamp}>{formatLogTime(entry.timestamp)}</span>
                <span className={entry.source === 'stderr' ? styles.logStderr : styles.logStdout}>
                  {entry.text}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
      <div className={styles.logControls}>
        <div className={styles.logBufferControl}>
          <span>{t('operator.logsBuffer')}</span>
          <input
            type="number"
            className={styles.logBufferInput}
            value={bufferSize}
            min={50}
            max={2000}
            step={50}
            onChange={(e) => handleBufferChange(e.target.value)}
          />
          <span>{t('operator.logsLines')}</span>
        </div>
        <button className={styles.logClearBtn} onClick={clearLogs}>
          <Trash2 size={12} />
          {t('operator.logsClear')}
        </button>
      </div>
    </>
  )
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

type VectorBusyOp = 'compacting' | 'resetting'

export default function OperatorPanel() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<OperatorStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [dbStatus, setDbStatus] = useState<OperatorDatabaseStatus | null>(null)
  const [dbTuning, setDbTuning] = useState<DatabaseTuningSettings>({ cacheMemoryPercent: null, mmapSizeBytes: null })
  const [dbMaintenanceSettings, setDbMaintenanceSettings] = useState<DatabaseMaintenanceSettings>({})
  const [sharpStatus, setSharpStatus] = useState<OperatorSharpStatus | null>(null)
  const [sharpSettings, setSharpSettings] = useState<SharpSettings>({})
  const [dnsStatus, setDnsStatus] = useState<OperatorDnsStatus | null>(null)
  const [dnsSettings, setDnsSettings] = useState<DnsSettings>({})
  const [uptime, setUptime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [isShutdown, setIsShutdown] = useState(false)
  const [vectorHealth, setVectorHealth] = useState<VectorStoreHealth | null>(null)
  const [vectorBusy, setVectorBusy] = useState<VectorBusyOp | null>(null)
  const [trustedHosts, setTrustedHosts] = useState<TrustedHostsResponse | null>(null)
  const [trustedHostsLoading, setTrustedHostsLoading] = useState(true)
  const [trustedHostsError, setTrustedHostsError] = useState<string | null>(null)
  const [hostDraft, setHostDraft] = useState('')
  const storeBusy = useStore((s) => s.operatorBusy)
  const storeProgressMessage = useStore((s) => s.operatorProgressMessage)
  const addToast = useStore((s) => s.addToast)

  // Track the operation that triggered a server restart so we can
  // show "Reconnecting..." once the WS drops and recover on reconnect.
  const pendingRestartOp = useRef<string | null>(null)
  const trustedHostsRequestId = useRef(0)

  const normalizedStoreBusy = normalizeOperatorOperation(storeBusy)
  const effectiveBusy = reconnecting ? 'reconnecting' : (normalizedStoreBusy || normalizeOperatorOperation(busy))
  const effectiveBusyMessage = !reconnecting && normalizedStoreBusy && storeProgressMessage
    ? storeProgressMessage
    : null
  const ipcAvailable = status?.ipcAvailable ?? false
  const ipcHint = useMemo(() => {
    if (!status) return null
    switch (status.ipcReason) {
      case 'connected':
        return t('operator.ipcConnected')
      case 'not_started_with_runner':
        return t('operator.ipcNotStarted')
      case 'runner_env_without_process_send':
        return t('operator.ipcNoProcessSend')
      default:
        return null
    }
  }, [status, t])

  const busyMessage = useCallback((op: string) => {
    const labels: Record<string, string> = {
      checking: t('operator.busyChecking'),
      updating: t('operator.busyUpdating'),
      'switching branch': t('operator.busySwitchingBranch'),
      restarting: t('operator.busyRestarting'),
      'shutting down': t('operator.busyShuttingDown'),
      'toggling remote': t('operator.busyTogglingRemote'),
      'clearing cache': t('operator.busyClearingCache'),
      'installing dependencies': t('operator.busyInstallingDeps'),
      'saving database tuning': t('operator.busySavingDbTuning'),
      'saving sharp settings': t('operator.busySavingSharp'),
      'saving database maintenance': t('operator.busySavingDbMaintenance'),
      'refreshing database stats': t('operator.busyRefreshingDbStats'),
      'database maintenance': t('operator.busyDbMaintenance'),
      'database vacuum': t('operator.busyDbVacuum'),
      'rebuilding frontend': t('operator.busyRebuildingFrontend'),
    }
    return labels[op] ?? `${op}...`
  }, [t])

  // ── Fetch status helper ─────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const s = await operatorApi.getStatus()
      setStatus(s)
      setStatusError(null)
      setUptime(s.uptime)
      return s
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : t('operator.loadStatusFailed'))
      return null
    }
  }, [t])

  const refreshDatabase = useCallback(async () => {
    try {
      const next = await operatorApi.getDatabase()
      setDbStatus(next)
      setDbTuning({
        cacheMemoryPercent: next.configuredSettings.cacheMemoryPercent ?? null,
        mmapSizeBytes: next.configuredSettings.mmapSizeBytes ?? null,
      })
      setDbMaintenanceSettings(next.maintenanceSettings)
      return next
    } catch {
      return null
    }
  }, [])

  const refreshTrustedHosts = useCallback(async (showLoader = false, forceRefresh = false) => {
    const requestId = ++trustedHostsRequestId.current
    if (showLoader) setTrustedHostsLoading(true)
    try {
      const res = await operatorApi.getTrustedHosts(forceRefresh)
      if (requestId !== trustedHostsRequestId.current) return
      setTrustedHosts(res)
      setTrustedHostsError(null)
    } catch (err) {
      if (requestId !== trustedHostsRequestId.current) return
      setTrustedHostsError(err instanceof Error ? err.message : t('operator.loadHostsFailed'))
    } finally {
      if (requestId === trustedHostsRequestId.current) {
        setTrustedHostsLoading(false)
      }
    }
  }, [t])

  const refreshSharpSettings = useCallback(async () => {
    try {
      const next = await operatorApi.getSharp()
      setSharpStatus(next)
      setSharpSettings({
        concurrency: next.configuredSettings.concurrency ?? null,
        cacheMemoryMb: next.configuredSettings.cacheMemoryMb ?? null,
        cacheFiles: next.configuredSettings.cacheFiles ?? null,
        cacheItems: next.configuredSettings.cacheItems ?? null,
      })
      return next
    } catch {
      return null
    }
  }, [])

  const refreshDnsSettings = useCallback(async () => {
    try {
      const next = await operatorApi.getDns()
      setDnsStatus(next)
      setDnsSettings({
        dohFallbackEnabled: next.configuredSettings.dohFallbackEnabled ?? false,
        dohEndpoint: next.configuredSettings.dohEndpoint,
      })
      return next
    } catch {
      return null
    }
  }, [])

  const saveTrustedHosts = useCallback(async (nextConfigured: string[]) => {
    try {
      trustedHostsRequestId.current += 1
      const res = await operatorApi.putTrustedHosts(nextConfigured)
      trustedHostsRequestId.current += 1
      setTrustedHosts((prev) => prev ? { ...prev, configured: res.configured, baseline: res.baseline } : prev)
      setTrustedHostsError(null)
      addToast({ type: 'success', message: t('operator.hostsUpdated') })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('operator.updateHostsFailed')
      addToast({ type: 'error', message })
      await refreshTrustedHosts()
    }
  }, [addToast, refreshTrustedHosts, t])

  const handleAddHost = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const current = trustedHosts?.configured ?? []
    if (current.some((h) => h.toLowerCase() === trimmed.toLowerCase())) {
      setHostDraft('')
      return
    }
    setHostDraft('')
    saveTrustedHosts([...current, trimmed])
  }, [saveTrustedHosts, trustedHosts])

  const handleRemoveHost = useCallback((host: string) => {
    const current = trustedHosts?.configured ?? []
    saveTrustedHosts(current.filter((h) => h !== host))
  }, [saveTrustedHosts, trustedHosts])

  const refreshVectorHealth = useCallback(async () => {
    try {
      const health = await embeddingsApi.getHealth()
      setVectorHealth(health)
    } catch {
      // Embeddings may not be configured — that's fine
    }
  }, [])

  const handleVectorOptimize = useCallback(async () => {
    setVectorBusy('compacting')
    try {
      await embeddingsApi.optimize()
      await refreshVectorHealth()
      addToast({ type: 'success', message: t('operator.vectorOptimizeSuccess') })
    } catch {
      addToast({ type: 'error', message: t('operator.vectorOptimizeFailed') })
    } finally {
      setVectorBusy(null)
    }
  }, [addToast, refreshVectorHealth, t])

  const handleVectorReset = useCallback(async () => {
    setVectorBusy('resetting')
    try {
      await embeddingsApi.forceReset()
      await refreshVectorHealth()
      addToast({ type: 'success', message: t('operator.vectorResetSuccess') })
    } catch {
      addToast({ type: 'error', message: t('operator.vectorResetFailed') })
    } finally {
      setVectorBusy(null)
    }
  }, [addToast, refreshVectorHealth, t])

  // Fetch status on mount and every 30s
  useEffect(() => {
    let mounted = true
    const fetchStatus = async () => {
      const [s] = await Promise.all([refreshStatus(), refreshDatabase(), refreshVectorHealth(), refreshSharpSettings(), refreshDnsSettings()])
      if (mounted && s) setLoading(false)
      else if (mounted) setLoading(false)
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [refreshDatabase, refreshDnsSettings, refreshSharpSettings, refreshStatus, refreshVectorHealth])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      refreshTrustedHosts()
    }, 0)
    const interval = window.setInterval(() => {
      refreshTrustedHosts()
    }, 30_000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
    }
  }, [refreshTrustedHosts])

  // Tick uptime every second (paused while reconnecting or shut down)
  useEffect(() => {
    if (reconnecting || isShutdown) return
    const interval = setInterval(() => setUptime((u) => u + 1000), 1000)
    return () => clearInterval(interval)
  }, [reconnecting, isShutdown])

  // ── WS disconnect / reconnect detection ─────────────────────────────────

  useEffect(() => {
    if (!normalizedStoreBusy || !RESTART_OPERATIONS.has(normalizedStoreBusy)) return
    pendingRestartOp.current = normalizedStoreBusy
  }, [normalizedStoreBusy])

  useEffect(() => {
    // Poll for WS disconnect when we're expecting a server restart.
    // Once we detect the drop, switch to "Reconnecting..." state.
    const disconnectPoll = setInterval(() => {
      if (pendingRestartOp.current && !wsClient.connected && !reconnecting) {
        setReconnecting(true)
        setBusy(null) // clear the operation-specific busy, we show reconnecting now
      }
    }, 500)

    // Listen for WS reconnection via the CONNECTED event.
    const unsub = wsClient.on(EventType.CONNECTED, () => {
      if (!reconnecting && !pendingRestartOp.current) return

      // Server is back — refresh everything
      pendingRestartOp.current = null
      setReconnecting(false)
      setBusy(null)
      useStore.getState().setOperatorBusy(null)
      useStore.getState().setOperatorProgressMessage(null)

      // Re-fetch status (new PID, uptime reset, possibly new branch/version)
      refreshStatus()
      refreshDatabase()
      refreshSharpSettings()
      refreshDnsSettings()
      refreshTrustedHosts()

      // Re-subscribe to log streaming
      operatorApi.subscribeLogs().catch(() => {})
    })

    return () => {
      clearInterval(disconnectPoll)
      unsub()
    }
  }, [reconnecting, refreshDatabase, refreshDnsSettings, refreshSharpSettings, refreshStatus, refreshTrustedHosts])

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Initiate an operation that will cause the server to restart. */
  const startRestartOperation = useCallback((opName: string) => {
    pendingRestartOp.current = opName
    setBusy(opName)
  }, [])

  const handleCheckUpdate = useCallback(async () => {
    setBusy('checking')
    try {
      const result = await operatorApi.checkUpdate()
      setStatus((prev) =>
        prev ? { ...prev, updateAvailable: result.available, commitsBehind: result.commitsBehind, latestUpdateMessage: result.latestMessage } : prev
      )
    } catch { /* handled by UI */ }
    setBusy(null)
  }, [])

  const handleApplyUpdate = useCallback(() => {
    setConfirm({
      title: t('operator.confirmUpdateTitle'),
      message: t('operator.confirmUpdateMessage', { count: status?.commitsBehind ?? 0 }),
      variant: 'warning',
      confirmText: t('operator.confirmUpdateRestart'),
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('updating')
        try {
          await operatorApi.applyUpdate()
        } catch { /* server will restart */ }
      },
    })
  }, [status?.commitsBehind, startRestartOperation, t])

  const handleSwitchBranch = useCallback((target: string) => {
    setConfirm({
      title: t('operator.confirmSwitchBranch'),
      message: t('operator.confirmSwitchBranchMessage', { branch: target }),
      variant: 'warning',
      confirmText: t('operator.confirmSwitchToBranch', { branch: target }),
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('switching branch')
        try {
          await operatorApi.switchBranch(target)
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation, t])

  const handleRestart = useCallback(() => {
    setConfirm({
      title: t('operator.confirmRestartTitle'),
      message: t('operator.confirmRestartMessage'),
      variant: 'warning',
      confirmText: t('operator.confirmRestart'),
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('restarting')
        try {
          await operatorApi.restart()
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation, t])

  const handleShutdown = useCallback(() => {
    setConfirm({
      title: t('operator.confirmShutdownTitle'),
      message: (
        <>
          <p>{t('operator.confirmShutdownP1')}</p>
          <p style={{ marginTop: 8, fontWeight: 500 }}>{t('operator.confirmShutdownP2')}</p>
        </>
      ),
      variant: 'danger',
      confirmText: t('operator.confirmShutdown'),
      onConfirm: async () => {
        setConfirm(null)
        setIsShutdown(true)
        setBusy('shutting down')
        try {
          await operatorApi.shutdown()
        } catch { /* expected — server is going down */ }
      },
    })
  }, [t])

  const handleToggleRemote = useCallback((enable: boolean) => {
    if (enable) {
      setConfirm({
        title: t('operator.confirmRemoteTitle'),
        message: (
          <>
            <p>{t('operator.confirmRemoteP1')}</p>
            <p style={{ marginTop: 8 }}>{t('operator.confirmRemoteP2')}</p>
            <p style={{ marginTop: 8 }}>{t('operator.confirmRemoteP3')}</p>
          </>
        ),
        variant: 'danger',
        confirmText: t('operator.confirmRemote'),
        onConfirm: async () => {
          setConfirm(null)
          startRestartOperation('toggling remote')
          try {
            await operatorApi.toggleRemote(true)
          } catch { /* server will restart */ }
        },
      })
    } else {
      startRestartOperation('toggling remote')
      operatorApi.toggleRemote(false).catch(() => {})
    }
  }, [startRestartOperation, t])

  const handleClearCache = useCallback(async () => {
    setBusy('clearing cache')
    try {
      await operatorApi.clearCache()
    } catch { /* handled by UI */ }
    setBusy(null)
  }, [])

  const handleEnsureDeps = useCallback(async () => {
    setBusy('installing dependencies')
    try {
      await operatorApi.ensureDependencies()
    } catch { /* handled by UI */ }
    setBusy(null)
  }, [])

  const handleRebuildFrontend = useCallback(() => {
    setConfirm({
      title: t('operator.confirmRebuildFrontend'),
      message: t('operator.confirmRebuildMessage'),
      variant: 'warning',
      confirmText: t('operator.confirmRebuild'),
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('rebuilding frontend')
        try {
          await operatorApi.rebuildFrontend()
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation, t])

  const handleSaveDatabaseTuning = useCallback(async () => {
    setBusy('saving database tuning')
    try {
      const normalized = normalizeDatabaseTuning(dbTuning)
      await settingsApi.put('databaseTuning', normalized)
      await refreshDatabase()
    } catch {
      /* handled by UI */
    }
    setBusy(null)
  }, [dbTuning, refreshDatabase])

  const handleRunDatabaseMaintenance = useCallback(async () => {
    setBusy('database maintenance')
    try {
      const normalized = normalizeDatabaseTuning(dbTuning)
      await settingsApi.put('databaseTuning', normalized)
      const result = await operatorApi.maintainDatabase({
        optimize: true,
        refreshTuning: true,
        checkpointMode: 'TRUNCATE',
      })
      setDbStatus((prev) => prev ? {
        ...prev,
        configuredSettings: normalized,
        effectiveTuning: result.tuning ?? prev.effectiveTuning,
        recommendation: {
          cacheMemoryPercent: (result.tuning ?? prev.effectiveTuning).cacheMemoryPercent,
          cacheBytes: (result.tuning ?? prev.effectiveTuning).cacheBytes,
          mmapSizeBytes: (result.tuning ?? prev.effectiveTuning).mmapSizeBytes,
        },
        stats: result.statsAfter,
      } : prev)
      await refreshDatabase()
      addToast({ type: 'success', message: t('operator.dbMaintenanceSuccess') })
    } catch {
      addToast({ type: 'error', message: t('operator.dbMaintenanceFailed') })
    }
    setBusy(null)
  }, [addToast, dbTuning, refreshDatabase, t])

  const handleSaveDatabaseMaintenance = useCallback(async () => {
    setBusy('saving database maintenance')
    try {
      const normalized = normalizeDatabaseMaintenance(dbMaintenanceSettings)
      await settingsApi.put('databaseMaintenance', normalized)
      await refreshDatabase()
    } catch {
      /* handled by UI */
    }
    setBusy(null)
  }, [dbMaintenanceSettings, refreshDatabase])

  const handleSaveSharpSettings = useCallback(async () => {
    setBusy('saving sharp settings')
    try {
      const normalized = normalizeSharpSettings(sharpSettings)
      const next = await operatorApi.putSharp(normalized)
      setSharpStatus(next)
      setSharpSettings({
        concurrency: next.configuredSettings.concurrency ?? null,
        cacheMemoryMb: next.configuredSettings.cacheMemoryMb ?? null,
        cacheFiles: next.configuredSettings.cacheFiles ?? null,
        cacheItems: next.configuredSettings.cacheItems ?? null,
      })
      addToast({ type: 'success', message: t('operator.sharpApplySuccess') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : t('operator.sharpApplyFailed') })
    }
    setBusy(null)
  }, [addToast, sharpSettings, t])

  const handleResetSharpSettings = useCallback(async () => {
    setBusy('saving sharp settings')
    try {
      const next = await operatorApi.putSharp({})
      setSharpStatus(next)
      setSharpSettings({
        concurrency: null,
        cacheMemoryMb: null,
        cacheFiles: null,
        cacheItems: null,
      })
      addToast({ type: 'success', message: t('operator.sharpResetSuccess') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : t('operator.sharpResetFailed') })
    }
    setBusy(null)
  }, [addToast, t])

  const handleSaveDnsSettings = useCallback(async (override?: DnsSettings) => {
    setBusy('saving dns settings')
    try {
      const payload = override ?? dnsSettings
      const next = await operatorApi.putDns({
        dohFallbackEnabled: payload.dohFallbackEnabled ?? false,
        dohEndpoint: payload.dohEndpoint,
      })
      setDnsStatus(next)
      setDnsSettings({
        dohFallbackEnabled: next.configuredSettings.dohFallbackEnabled ?? false,
        dohEndpoint: next.configuredSettings.dohEndpoint,
      })
      addToast({ type: 'success', message: 'DNS settings applied.' })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to apply DNS settings.' })
    }
    setBusy(null)
  }, [addToast, dnsSettings])

  const handleRunVacuumNow = useCallback(() => {
    const normalizedTuning = normalizeDatabaseTuning(dbTuning)
    const normalizedMaintenance = normalizeDatabaseMaintenance(dbMaintenanceSettings)
    setConfirm({
      title: t('operator.confirmVacuumTitle'),
      message: (
        <>
          <p>{t('operator.confirmVacuumP1')}</p>
          <p style={{ marginTop: 8 }}>
            {t('operator.confirmVacuumScratch', {
              needed: formatBytes(dbStatus?.stats?.vacuumEstimatedRequiredBytes ?? 0),
              free: formatBytes(dbStatus?.stats?.filesystemFreeBytes ?? 0),
            })}
          </p>
          <p style={{ marginTop: 8 }}>
            {t('operator.confirmVacuumReclaim', {
              reclaimable: formatBytes(dbStatus?.stats?.freeBytes ?? 0),
              generations: dbStatus?.automaticMaintenance?.activeGenerationCount ?? 0,
            })}
          </p>
          <p style={{ marginTop: 8, opacity: 0.85 }}>{t('operator.confirmVacuumP2')}</p>
        </>
      ),
      variant: 'warning',
      confirmText: t('operator.confirmVacuum'),
      onConfirm: async () => {
        setConfirm(null)
        setBusy('database vacuum')
        try {
          await settingsApi.put('databaseTuning', normalizedTuning)
          const result = await operatorApi.maintainDatabase({
            optimize: true,
            analyze: true,
            vacuum: true,
            refreshTuning: true,
            checkpointMode: normalizedMaintenance.vacuumCheckpointMode ?? 'TRUNCATE',
          })
          setDbStatus((prev) => prev ? {
            ...prev,
            configuredSettings: normalizedTuning,
            stats: result.statsAfter,
            effectiveTuning: result.tuning ?? prev.effectiveTuning,
            recommendation: {
              cacheMemoryPercent: (result.tuning ?? prev.effectiveTuning).cacheMemoryPercent,
              cacheBytes: (result.tuning ?? prev.effectiveTuning).cacheBytes,
              mmapSizeBytes: (result.tuning ?? prev.effectiveTuning).mmapSizeBytes,
            },
            maintenanceState: result.state ?? prev.maintenanceState,
          } : prev)
          await refreshDatabase()
          addToast({ type: 'success', message: t('operator.vacuumSuccess') })
        } catch (err) {
          addToast({ type: 'error', message: err instanceof Error ? err.message : t('operator.vacuumFailed') })
        }
        setBusy(null)
      },
    })
  }, [addToast, dbMaintenanceSettings, dbStatus, dbTuning, refreshDatabase, t])

  const handleRefreshDatabase = useCallback(async () => {
    setBusy('refreshing database stats')
    try {
      await refreshDatabase()
    } finally {
      setBusy(null)
    }
  }, [refreshDatabase])

  const hostSourceLabel = useCallback(
    (source: TrustedHostEntry['source']) => t(hostSourceKey(source)),
    [t],
  )

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={styles.container}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lumiverse-text-dim)', fontSize: 13 }}>
          <Loader2 size={16} className={spinClass} /> {t('operator.loadingStatus')}
        </div>
      </div>
    )
  }

  // Permanent shutdown state — no reconnection
  if (isShutdown) {
    return (
      <div className={styles.container}>
        <div className={styles.shutdownBanner}>
          <PowerOff size={18} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('operator.serverShutdown')}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{t('operator.shutdownHint')}</div>
          </div>
        </div>
      </div>
    )
  }

  const currentBranch = status?.branch ?? 'unknown'
  const otherBranch = currentBranch === 'main' ? 'staging' : 'main'
  const mmapSupported = dbStatus?.effectiveTuning.mmapSource !== 'disabled'
  const dbStats = dbStatus?.stats
  const effectiveTuning = dbStatus?.effectiveTuning
  const autoMaintenance = dbStatus?.automaticMaintenance
  const maintenanceState = dbStatus?.maintenanceState
  const vacuumDiskWarning = dbStats?.vacuumHasEnoughFreeBytes === false
  const trustedHostsReady = !!trustedHosts

  return (
    <div className={styles.container}>
      {/* Status Grid */}
      <div className={styles.statusGrid}>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.port')}</span>
          <span className={styles.statusValue}>{status?.port ?? '—'}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.pid')}</span>
          <span className={styles.statusValue}>{status?.pid ?? '—'}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.uptime')}</span>
          <span className={styles.statusValue}>{formatUptime(uptime)}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.branch')}</span>
          <span className={styles.statusValue}>{currentBranch}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.version')}</span>
          <span className={styles.statusValue}>
            {status?.version ?? '—'}
            {status?.commit ? <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 4 }}>({status.commit})</span> : null}
          </span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>{t('operator.runnerIpc')}</span>
          <span className={clsx(styles.ipcBadge, ipcAvailable ? styles.ipcAvailable : styles.ipcUnavailable)}>
            {ipcAvailable ? t('operator.connected') : t('operator.unavailable')}
          </span>
        </div>
      </div>

      {/* Update badge */}
      {status?.updateAvailable && (
        <div className={styles.updateBadge}>
          <Download size={12} />
          {t('operator.updatesAvailable', { count: status.commitsBehind ?? 0 })}
          {status.latestUpdateMessage ? ` — ${status.latestUpdateMessage}` : ''}
        </div>
      )}

      {/* Reconnecting banner */}
      {reconnecting && (
        <div className={styles.reconnectBanner}>
          <Loader2 size={16} className={spinClass} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('operator.reconnectingTitle')}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{t('operator.reconnectingHint')}</div>
          </div>
        </div>
      )}

      {/* Busy indicator (non-reconnect operations) */}
      {effectiveBusy && effectiveBusy !== 'reconnecting' && (
        <div className={styles.busyOverlay}>
          <Loader2 size={16} className={spinClass} />
          {effectiveBusyMessage ?? busyMessage(effectiveBusy)}
        </div>
      )}

      {/* Controls */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.serverControls')}</span>
        </div>
        <div className={styles.sectionBody}>
          {statusError && (
            <div className={styles.disabledHint}>
              {t('operator.statusUnavailable', { error: statusError })}
            </div>
          )}
          {!statusError && !ipcAvailable && ipcHint && (
            <div className={styles.disabledHint}>
              {ipcHint}
            </div>
          )}
          <div className={styles.controls}>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleCheckUpdate}
            >
              <RefreshCw size={14} />
              {t('operator.checkUpdates')}
            </button>
            {status?.updateAvailable && (
              <button
                className={styles.controlBtnPrimary}
                disabled={!ipcAvailable || !!effectiveBusy}
                onClick={handleApplyUpdate}
              >
                <Download size={14} />
                {t('operator.applyUpdate')}
              </button>
            )}
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={() => handleSwitchBranch(otherBranch)}
            >
              <GitBranch size={14} />
              {t('operator.switchBranch', { branch: otherBranch })}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleRestart}
            >
              <Power size={14} />
              {t('operator.restartServer')}
            </button>
            <button
              className={styles.controlBtnDanger}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleShutdown}
            >
              <PowerOff size={14} />
              {t('operator.shutDown')}
            </button>
          </div>
        </div>
      </div>

      {/* Maintenance */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.maintenance')}</span>
        </div>
        <div className={styles.sectionBody}>
          {statusError && (
            <div className={styles.disabledHint}>
              {t('operator.statusUnavailable', { error: statusError })}
            </div>
          )}
          {!statusError && !ipcAvailable && ipcHint && (
            <div className={styles.disabledHint}>
              {ipcHint}
            </div>
          )}
          <div className={styles.controls}>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleClearCache}
            >
              <HardDrive size={14} />
              {t('operator.clearPackageCache')}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleEnsureDeps}
            >
              <PackageCheck size={14} />
              {t('operator.ensureDependencies')}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleRebuildFrontend}
            >
              <Hammer size={14} />
              {t('operator.rebuildFrontendBtn')}
            </button>
          </div>
        </div>
      </div>

      {/* Remote Mode */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.remoteAccess')}</span>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.remoteRow}>
            <div className={styles.remoteInfo}>
              <span className={styles.remoteLabel}>
                {status?.remoteMode ? <Wifi size={14} style={{ marginRight: 6 }} /> : <WifiOff size={14} style={{ marginRight: 6, opacity: 0.5 }} />}
                {t('operator.remoteMode')}
              </span>
              <span className={styles.remoteHint}>
                {status?.remoteMode
                  ? t('operator.remoteAcceptAny')
                  : t('operator.remoteLocalOnly')}
              </span>
            </div>
            <Toggle.Switch
              checked={status?.remoteMode ?? false}
              onChange={handleToggleRemote}
              disabled={!ipcAvailable || !!effectiveBusy}
            />
          </div>
        </div>
      </div>

      {/* Trusted Hostnames */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.trustedHostnames')}</span>
        </div>
        <div className={styles.sectionBody}>
          <span className={styles.remoteHint}>{t('operator.hostsHint')}</span>

          {trustedHostsLoading && !trustedHosts && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lumiverse-text-dim)', fontSize: 12 }}>
              <Loader2 size={14} className={spinClass} /> {t('operator.hostsDetecting')}
            </div>
          )}

          {trustedHostsError && (
            <div className={styles.disabledHint}>
              {trustedHosts
                ? t('operator.hostsRefreshFailed', { error: trustedHostsError })
                : t('operator.hostsDetectFailed', { error: trustedHostsError })}
            </div>
          )}

          {trustedHosts && (
            <>
              <div className={styles.dbInfoBlock}>
                <span className={styles.fieldLabel}>{t('operator.hostsAlwaysTrusted')}</span>
                <div className={styles.hostChipGroup}>
                  {trustedHosts.baseline.map((entry) => (
                    <span key={entry.host} className={styles.hostChipBaseline} title={t('operator.hostsSource', { source: hostSourceLabel(entry.source) })}>
                      {entry.host}
                      <span className={styles.hostChipSource}>{hostSourceLabel(entry.source)}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className={styles.dbInfoBlock}>
                <span className={styles.fieldLabel}>{t('operator.hostsConfigured')}</span>
                {trustedHosts.configured.length > 0 ? (
                  <div className={styles.hostChipGroup}>
                    {trustedHosts.configured.map((host) => (
                      <span key={host} className={styles.hostChip}>
                        {host}
                        <button
                          type="button"
                          className={styles.hostChipRemove}
                          onClick={() => handleRemoveHost(host)}
                          aria-label={t('operator.hostsRemove', { host })}
                          disabled={!trustedHostsReady}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className={styles.hostEmpty}>{t('operator.hostsNoCustom')}</span>
                )}
              </div>

              {trustedHosts.suggestions.length > 0 && (
                <div className={styles.dbInfoBlock}>
                  <span className={styles.fieldLabel}>{t('operator.hostsDetected')}</span>
                  <div className={styles.hostChipGroup}>
                    {trustedHosts.suggestions.map((entry) => {
                      const alreadyConfigured = trustedHosts.configured.includes(entry.host)
                      return (
                        <button
                          key={entry.host}
                          type="button"
                          className={styles.hostChipSuggested}
                          disabled={!trustedHostsReady || alreadyConfigured}
                          onClick={() => handleAddHost(entry.host)}
                          title={t('operator.hostsSource', { source: hostSourceLabel(entry.source) })}
                        >
                          <Plus size={11} />
                          {entry.host}
                          <span className={styles.hostChipSource}>{hostSourceLabel(entry.source)}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {!trustedHosts && !trustedHostsLoading && !trustedHostsError && (
            <div className={styles.dbInfoBlock}>
              <span className={styles.hostEmpty}>{t('operator.hostsNotLoaded')}</span>
            </div>
          )}

          <div className={styles.dbInfoBlock}>
            <span className={styles.fieldLabel}>{t('operator.hostsAddManually')}</span>
            <form
              className={styles.hostInputRow}
              onSubmit={(e) => {
                e.preventDefault()
                handleAddHost(hostDraft)
              }}
            >
              <input
                type="text"
                className={styles.hostInput}
                placeholder={t('operator.hostsPlaceholder')}
                value={hostDraft}
                onChange={(e) => setHostDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={!trustedHostsReady}
              />
              <button
                type="submit"
                className={styles.controlBtnPrimary}
                disabled={!trustedHostsReady || !hostDraft.trim()}
              >
                <Globe size={14} />
                {t('operator.hostsAdd')}
              </button>
              <button
                type="button"
                className={styles.controlBtn}
                onClick={() => refreshTrustedHosts(true, true)}
                disabled={trustedHostsLoading}
              >
                <RefreshCw size={14} className={trustedHostsLoading ? spinClass : undefined} />
                {t('operator.hostsRescan')}
              </button>
            </form>
            <span className={styles.fieldHint}>
              {t('operator.hostsPortHint', { port: status?.port ?? '7860' })}
              {!trustedHostsReady ? t('operator.hostsLoadSnapshotHint') : ''}
            </span>
          </div>
        </div>
      </div>

      {/* Database */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.database')}</span>
        </div>
        <div className={styles.sectionBody}>
          {dbStats && (
            <div className={styles.statusGrid}>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbFile')}</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.fileBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbWal')}</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.walBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbLivePages')}</span>
                <span className={styles.statusValue}>{dbStats.pageCount.toLocaleString()}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbFreelist')}</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.freeBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbCache')}</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.cacheBytesApprox)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>{t('operator.dbMmap')}</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.mmapSize)}</span>
              </div>
            </div>
          )}

          <div className={styles.dbInfoGrid}>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.dbPath')}</span>
              <span className={styles.dbMono}>{dbStats?.path ?? '—'}</span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.dbPragmas')}</span>
              <span className={styles.dbInlineText}>
                {t('operator.dbPragmasValue', {
                  journal: dbStats?.journalMode ?? '—',
                  sync: dbStats?.synchronous ?? '—',
                  temp: dbStats?.tempStore ?? '—',
                  checkpoint: dbStats?.walAutocheckpoint ?? '—',
                })}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.dbResolvedTuning')}</span>
              <span className={styles.dbInlineText}>
                {effectiveTuning
                  ? t('operator.dbResolvedTuningValue', {
                    cache: formatBytes(effectiveTuning.cacheBytes),
                    cacheSource: effectiveTuning.cacheSource,
                    mmap: formatBytes(effectiveTuning.mmapSizeBytes),
                    mmapSource: effectiveTuning.mmapSource,
                    journalCap: formatBytes(effectiveTuning.journalSizeLimitBytes),
                  })
                  : '—'}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.dbDiskHeadroom')}</span>
              <span className={styles.dbInlineText}>
                {t('operator.dbDiskHeadroomValue', {
                  free: formatBytes(dbStats?.filesystemFreeBytes ?? 0),
                  needed: formatBytes(dbStats?.vacuumEstimatedRequiredBytes ?? 0),
                  status: dbStats?.vacuumHasEnoughFreeBytes === null
                    ? t('operator.dbDiskUnknown')
                    : dbStats?.vacuumHasEnoughFreeBytes
                      ? t('operator.dbDiskEnough')
                      : t('operator.dbDiskNotEnough'),
                })}
              </span>
            </div>
          </div>

          {vacuumDiskWarning && (
            <div className={styles.warningBanner}>
              {t('operator.dbVacuumUnsafe', {
                needed: formatBytes(dbStats?.vacuumEstimatedRequiredBytes ?? 0),
                free: formatBytes(dbStats?.filesystemFreeBytes ?? 0),
              })}
            </div>
          )}

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbCachePercent')}</span>
              <NumericInput
                min={0.1}
                max={50}
                step={0.1}
                className={styles.fieldInput}
                placeholder={t('operator.mmapAuto')}
                value={dbTuning.cacheMemoryPercent ?? null}
                allowEmpty
                onChange={(value) => setDbTuning((prev) => ({
                  ...prev,
                  cacheMemoryPercent: value,
                }))}
              />
              <span className={styles.fieldHint}>
                {t('operator.dbCachePercentHint', {
                  size: effectiveTuning ? formatBytes(effectiveTuning.cacheBytes) : '—',
                })}
              </span>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbMmapSize')}</span>
              <NumericInput
                min={0}
                step={16}
                className={styles.fieldInput}
                placeholder={mmapSupported ? t('operator.mmapAuto') : t('operator.mmapDisabledWindows')}
                disabled={!mmapSupported}
                value={dbTuning.mmapSizeBytes == null ? null : Math.round(dbTuning.mmapSizeBytes / (1024 * 1024))}
                integer
                allowEmpty
                onChange={(value) => setDbTuning((prev) => ({
                  ...prev,
                  mmapSizeBytes: value == null ? null : value * 1024 * 1024,
                }))}
              />
              <span className={styles.fieldHint}>{t('operator.dbMmapHint')}</span>
            </label>
          </div>

          <div className={styles.dbInfoGrid}>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>{t('operator.dbAutoMaintenance')}</span>
              <span className={styles.dbInlineText}>
                {t('operator.dbAutoMaintenanceValue', {
                  optimize: formatTimestamp(maintenanceState?.lastOptimizeAt),
                  analyze: formatTimestamp(maintenanceState?.lastAnalyzeAt),
                  vacuum: formatTimestamp(maintenanceState?.lastVacuumAt),
                })}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>{t('operator.dbAutoVacuumStatus')}</span>
              <span className={styles.dbInlineText}>
                {autoMaintenance?.vacuum.eligible
                  ? t('operator.vacuumEligible')
                  : autoMaintenance?.vacuum.blockedReasons.length
                    ? autoMaintenance.vacuum.blockedReasons.join(' · ')
                    : t('operator.vacuumIdle')}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>{t('operator.dbIdleSignals')}</span>
              <span className={styles.dbInlineText}>
                {t('operator.dbIdleSignalsValue', {
                  visible: autoMaintenance?.visibility.visibleSessions ?? 0,
                  total: autoMaintenance?.visibility.totalSessions ?? 0,
                  hidden: autoMaintenance?.visibility.hiddenIdleMinutes ?? 0,
                  lastWrite: autoMaintenance?.lastWriteIdleMinutes == null
                    ? '—'
                    : t('operator.dbLastWriteAgo', { minutes: autoMaintenance.lastWriteIdleMinutes }),
                  generations: autoMaintenance?.activeGenerationCount ?? 0,
                })}
              </span>
            </div>
          </div>

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbOptimizeInterval')}</span>
              <NumericInput
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDisabled')}
                value={dbMaintenanceSettings.optimizeIntervalHours ?? null}
                integer
                allowEmpty
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  optimizeIntervalHours: value,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbAnalyzeInterval')}</span>
              <NumericInput
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDisabled')}
                value={dbMaintenanceSettings.analyzeIntervalHours ?? null}
                integer
                allowEmpty
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  analyzeIntervalHours: value,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbVacuumInterval')}</span>
              <NumericInput
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDisabled')}
                value={dbMaintenanceSettings.vacuumIntervalHours ?? null}
                integer
                allowEmpty
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumIntervalHours: value,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbVacuumIdle')}</span>
              <NumericInput
                min={1}
                step={1}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinIdleMinutes ?? 15}
                integer
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinIdleMinutes: value ?? 15,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbMinReclaim')}</span>
              <NumericInput
                min={0}
                step={64}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinReclaimBytes == null ? null : Math.round(dbMaintenanceSettings.vacuumMinReclaimBytes / (1024 * 1024))}
                integer
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinReclaimBytes: (value ?? 0) * 1024 * 1024,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbMinReclaimPercent')}</span>
              <NumericInput
                min={0}
                max={100}
                step={1}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinReclaimPercent ?? 15}
                integer
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinReclaimPercent: value ?? 15,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbMinSize')}</span>
              <NumericInput
                min={0}
                step={256}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinDbSizeBytes == null ? null : Math.round(dbMaintenanceSettings.vacuumMinDbSizeBytes / (1024 * 1024))}
                integer
                onChange={(value) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinDbSizeBytes: (value ?? 0) * 1024 * 1024,
                }))}
              />
            </label>
          </div>

          <div className={styles.toggleRow}>
            <div className={styles.remoteInfo}>
              <span className={styles.remoteLabel}>{t('operator.dbEnableAutoVacuum')}</span>
              <span className={styles.remoteHint}>{t('operator.dbEnableAutoVacuumHint')}</span>
            </div>
            <Toggle.Switch
              checked={dbMaintenanceSettings.autoVacuumEnabled ?? false}
              onChange={(checked) => setDbMaintenanceSettings((prev) => ({ ...prev, autoVacuumEnabled: checked }))}
              disabled={!!effectiveBusy}
            />
          </div>

          <div className={styles.toggleGrid}>
            <div className={styles.toggleRowCompact}>
              <span className={styles.remoteHint}>{t('operator.dbRequireNoClients')}</span>
              <Toggle.Switch
                checked={dbMaintenanceSettings.vacuumRequireNoVisibleClients !== false}
                onChange={(checked) => setDbMaintenanceSettings((prev) => ({ ...prev, vacuumRequireNoVisibleClients: checked }))}
                disabled={!!effectiveBusy}
              />
            </div>
            <div className={styles.toggleRowCompact}>
              <span className={styles.remoteHint}>{t('operator.dbRequireNoGenerations')}</span>
              <Toggle.Switch
                checked={dbMaintenanceSettings.vacuumRequireNoActiveGenerations !== false}
                onChange={(checked) => setDbMaintenanceSettings((prev) => ({ ...prev, vacuumRequireNoActiveGenerations: checked }))}
                disabled={!!effectiveBusy}
              />
            </div>
          </div>

          <div className={styles.controls}>
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleRefreshDatabase}>
              <RefreshCw size={14} />
              {t('operator.dbRefreshStats')}
            </button>
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleSaveDatabaseTuning}>
              <HardDrive size={14} />
              {t('operator.dbSaveTuning')}
            </button>
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleSaveDatabaseMaintenance}>
              <HardDrive size={14} />
              {t('operator.dbSaveMaintenance')}
            </button>
            <button className={styles.controlBtnPrimary} disabled={!!effectiveBusy} onClick={handleRunDatabaseMaintenance}>
              <Hammer size={14} />
              {t('operator.dbApplyOptimize')}
            </button>
            <button className={styles.controlBtnDanger} disabled={!!effectiveBusy || vacuumDiskWarning} onClick={handleRunVacuumNow}>
              <Hammer size={14} />
              {t('operator.dbRunVacuum')}
            </button>
          </div>
        </div>
      </div>

      {/* Image Processing */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.imageProcessing')}</span>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.dbInfoGrid}>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.sharpEffective')}</span>
              <span className={styles.dbInlineText}>
                {sharpStatus
                  ? t('operator.sharpEffectiveValue', {
                    concurrency: sharpStatus.effectiveSettings.concurrency,
                    cacheMb: sharpStatus.effectiveSettings.cacheMemoryMb,
                    cacheFiles: sharpStatus.effectiveSettings.cacheFiles,
                    cacheItems: sharpStatus.effectiveSettings.cacheItems,
                  })
                  : '—'}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.sharpDefaults')}</span>
              <span className={styles.dbInlineText}>
                {sharpStatus
                  ? t('operator.sharpEffectiveValue', {
                    concurrency: sharpStatus.defaults.concurrency,
                    cacheMb: sharpStatus.defaults.cacheMemoryMb,
                    cacheFiles: sharpStatus.defaults.cacheFiles,
                    cacheItems: sharpStatus.defaults.cacheItems,
                  })
                  : '—'}
              </span>
            </div>
          </div>

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.sharpConcurrency')}</span>
              <NumericInput
                min={1}
                max={16}
                step={1}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', { value: sharpStatus?.defaults.concurrency ?? 4 })}
                value={sharpSettings.concurrency ?? null}
                integer
                allowEmpty
                onChange={(value) => setSharpSettings((prev) => ({ ...prev, concurrency: value }))}
              />
              <span className={styles.fieldHint}>{t('operator.sharpConcurrencyHint')}</span>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.sharpCacheMemory')}</span>
              <NumericInput
                min={8}
                max={512}
                step={8}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', { value: sharpStatus?.defaults.cacheMemoryMb ?? 64 })}
                value={sharpSettings.cacheMemoryMb ?? null}
                integer
                allowEmpty
                onChange={(value) => setSharpSettings((prev) => ({ ...prev, cacheMemoryMb: value }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.sharpCacheFiles')}</span>
              <NumericInput
                min={0}
                max={2048}
                step={16}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', { value: sharpStatus?.defaults.cacheFiles ?? 128 })}
                value={sharpSettings.cacheFiles ?? null}
                integer
                allowEmpty
                onChange={(value) => setSharpSettings((prev) => ({ ...prev, cacheFiles: value }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.sharpCacheItems')}</span>
              <NumericInput
                min={1}
                max={4096}
                step={16}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', { value: sharpStatus?.defaults.cacheItems ?? 256 })}
                value={sharpSettings.cacheItems ?? null}
                integer
                allowEmpty
                onChange={(value) => setSharpSettings((prev) => ({ ...prev, cacheItems: value }))}
              />
            </label>
          </div>

          <div className={styles.controls}>
            <button
              className={styles.controlBtnPrimary}
              disabled={!!effectiveBusy}
              onClick={handleSaveSharpSettings}
            >
              <HardDrive size={14} />
              {t('operator.sharpApply')}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!!effectiveBusy}
              onClick={handleResetSharpSettings}
            >
              <RefreshCw size={14} />
              {t('operator.sharpResetDefaults')}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!!effectiveBusy}
              onClick={refreshSharpSettings}
            >
              <RefreshCw size={14} />
              {t('operator.refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* DNS Resolution */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>DNS Resolution</span>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.toggleRow}>
            <div className={styles.remoteInfo}>
              <span className={styles.remoteLabel}>DoH fallback for SSRF validation</span>
              <span className={styles.remoteHint}>
                When the system resolver can't resolve a hostname (e.g. Termux on Android with custom TLDs like
                {' '}<code>.spot</code>, or Tailscale split-horizon), fall back to DNS-over-HTTPS to validate the IP
                before fetching. Off by default — only enable if outbound DNS is the bottleneck.
              </span>
            </div>
            <Toggle.Switch
              checked={dnsSettings.dohFallbackEnabled ?? false}
              onChange={(checked) => {
                const next: DnsSettings = { ...dnsSettings, dohFallbackEnabled: checked }
                setDnsSettings(next)
                handleSaveDnsSettings(next)
              }}
              disabled={!!effectiveBusy}
            />
          </div>

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>DoH endpoint</span>
              <input
                type="text"
                className={styles.hostInput}
                placeholder={dnsStatus?.defaults.dohEndpoint ?? 'https://1.1.1.1/dns-query'}
                value={dnsSettings.dohEndpoint ?? ''}
                onChange={(e) => setDnsSettings((prev) => ({ ...prev, dohEndpoint: e.target.value || undefined }))}
                autoComplete="off"
                spellCheck={false}
                disabled={!!effectiveBusy}
              />
              <span className={styles.fieldHint}>
                Must be HTTPS and serve the RFC 8484 JSON wire format. Use an IP literal in the URL so the endpoint
                itself doesn't need DNS to reach.
              </span>
            </label>
          </div>

          <div className={styles.controls}>
            <button
              className={styles.controlBtnPrimary}
              disabled={!!effectiveBusy}
              onClick={() => handleSaveDnsSettings()}
            >
              <Globe size={14} />
              Apply DNS Settings
            </button>
            <button
              className={styles.controlBtn}
              disabled={!!effectiveBusy}
              onClick={refreshDnsSettings}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* LanceDB Vector Store */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.vectorStore')}</span>
        </div>
        <div className={styles.sectionBody}>
          {vectorHealth ? (
            vectorHealth.exists ? (
              <>
                {Object.entries(vectorHealth.tables ?? { embeddings: vectorHealth }).map(([tableName, tableHealth]) => (
                  <div key={tableName} style={{ marginBottom: 16 }}>
                    <div className={styles.dbInfoGrid} style={{ marginBottom: 10 }}>
                      <div className={styles.dbInfoBlock}>
                        <span className={styles.statusLabel}>{t('operator.vectorTable')}</span>
                        <span className={styles.dbInlineText}>{tableName}</span>
                      </div>
                    </div>

                    {tableHealth.exists ? (
                      <>
                        <div className={styles.statusGrid}>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorRows')}</span>
                            <span className={styles.statusValue}>{tableHealth.rowCount.toLocaleString()}</span>
                          </div>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorIndex')}</span>
                            <span className={styles.statusValue}>{tableHealth.vectorIndexReady ? t('operator.indexActive') : t('operator.indexPending')}</span>
                          </div>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorScalarIndexes')}</span>
                            <span className={styles.statusValue}>{tableHealth.scalarIndexReady ? t('operator.indexActive') : t('operator.indexPending')}</span>
                          </div>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorFtsIndex')}</span>
                            <span className={styles.statusValue}>{tableHealth.ftsIndexReady ? t('operator.indexActive') : t('operator.indexPending')}</span>
                          </div>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorUnindexedRows')}</span>
                            <span className={styles.statusValue}>{tableHealth.unindexedRowEstimate.toLocaleString()}</span>
                          </div>
                          <div className={styles.statusCard}>
                            <span className={styles.statusLabel}>{t('operator.vectorIndexes')}</span>
                            <span className={styles.statusValue}>{tableHealth.indexes.length}</span>
                          </div>
                        </div>

                        {tableHealth.indexes.length > 0 && (
                          <div className={styles.dbInfoGrid}>
                            <div className={styles.dbInfoBlock}>
                              <span className={styles.statusLabel}>{t('operator.vectorIndexDetails')}</span>
                              <span className={styles.dbInlineText}>
                                {tableHealth.indexes.map((idx) =>
                                  idx.type ? `${idx.name} (${idx.type})` : idx.name
                                ).join(' · ')}
                              </span>
                            </div>
                            {tableHealth.lastIndexRebuildAt > 0 && (
                              <div className={styles.dbInfoBlock}>
                                <span className={styles.statusLabel}>{t('operator.vectorLastRebuild')}</span>
                                <span className={styles.dbInlineText}>
                                  {new Date(tableHealth.lastIndexRebuildAt).toLocaleString()}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className={styles.disabledHint}>
                        {t('operator.vectorTableNotInit')}
                      </div>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <div className={styles.disabledHint}>
                {t('operator.vectorNotInit')}
              </div>
            )
          ) : (
            <div className={styles.disabledHint}>{t('operator.vectorLoading')}</div>
          )}

          <div className={styles.controls}>
            <button className={styles.controlBtn} disabled={!!vectorBusy} onClick={refreshVectorHealth}>
              <RefreshCw size={14} />
              {t('operator.refresh')}
            </button>
            <button
              className={styles.controlBtnPrimary}
              disabled={!!vectorBusy || !vectorHealth?.exists}
              onClick={handleVectorOptimize}
            >
              {vectorBusy === 'compacting'
                ? <Loader2 size={14} className={spinClass} />
                : <Hammer size={14} />}
              {t('operator.compactRebuildIndex')}
            </button>
            <button
              className={styles.controlBtnDanger}
              disabled={!!vectorBusy || !vectorHealth?.exists}
              onClick={() => setConfirm({
                title: t('operator.confirmVectorResetTitle'),
                message: t('operator.confirmVectorResetMessage'),
                variant: 'danger',
                confirmText: t('operator.confirmVectorReset'),
                onConfirm: async () => {
                  setConfirm(null)
                  await handleVectorReset()
                },
              })}
            >
              {vectorBusy === 'resetting'
                ? <Loader2 size={14} className={spinClass} />
                : <Trash2 size={14} />}
              {t('operator.forceReset')}
            </button>
          </div>
        </div>
      </div>

      {/* Log Viewer */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.serverLogs')}</span>
        </div>
        <div className={styles.sectionBody}>
          <LogViewer />
        </div>
      </div>

      {/* Confirmation modal */}
      <ConfirmationModal
        isOpen={confirm !== null}
        title={confirm?.title}
        message={confirm?.message}
        variant={confirm?.variant}
        confirmText={confirm?.confirmText}
        onConfirm={confirm?.onConfirm ?? (() => {})}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
