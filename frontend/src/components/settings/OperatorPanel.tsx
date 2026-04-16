import { useEffect, useRef, useState, useCallback } from 'react'
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
} from 'lucide-react'
import { Toggle } from '@/components/shared/Toggle'
import { spinClass } from '@/components/shared/Spinner'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useStore } from '@/store'
import {
  type DatabaseMaintenanceSettings,
  operatorApi,
  type DatabaseTuningSettings,
  type OperatorDatabaseStatus,
  type OperatorStatus,
} from '@/api/operator'
import { settingsApi } from '@/api/settings'
import { embeddingsApi, type VectorStoreHealth } from '@/api/embeddings'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import styles from './OperatorPanel.module.css'
import clsx from 'clsx'

/** Operations that cause the server to restart and require reconnection handling. */
const RESTART_OPERATIONS = new Set(['updating', 'switching branch', 'restarting', 'toggling remote', 'rebuilding frontend'])

// ─── Helpers ────────────────────────────────────────────────────────────────

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
            <div className={styles.logEmpty}>No log entries yet. Server output will appear here.</div>
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
          <span>Buffer:</span>
          <input
            type="number"
            className={styles.logBufferInput}
            value={bufferSize}
            min={50}
            max={2000}
            step={50}
            onChange={(e) => handleBufferChange(e.target.value)}
          />
          <span>lines</span>
        </div>
        <button className={styles.logClearBtn} onClick={clearLogs}>
          <Trash2 size={12} />
          Clear
        </button>
      </div>
    </>
  )
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function OperatorPanel() {
  const [status, setStatus] = useState<OperatorStatus | null>(null)
  const [dbStatus, setDbStatus] = useState<OperatorDatabaseStatus | null>(null)
  const [dbTuning, setDbTuning] = useState<DatabaseTuningSettings>({ cacheMemoryPercent: null, mmapSizeBytes: null })
  const [dbMaintenanceSettings, setDbMaintenanceSettings] = useState<DatabaseMaintenanceSettings>({})
  const [uptime, setUptime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [isShutdown, setIsShutdown] = useState(false)
  const [vectorHealth, setVectorHealth] = useState<VectorStoreHealth | null>(null)
  const [vectorBusy, setVectorBusy] = useState<string | null>(null)
  const storeBusy = useStore((s) => s.operatorBusy)
  const addToast = useStore((s) => s.addToast)

  // Track the operation that triggered a server restart so we can
  // show "Reconnecting..." once the WS drops and recover on reconnect.
  const pendingRestartOp = useRef<string | null>(null)

  const effectiveBusy = reconnecting ? 'reconnecting' : (storeBusy || busy)
  const ipcAvailable = status?.ipcAvailable ?? false

  // ── Fetch status helper ─────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const s = await operatorApi.getStatus()
      setStatus(s)
      setUptime(s.uptime)
      return s
    } catch {
      return null
    }
  }, [])

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

  const refreshVectorHealth = useCallback(async () => {
    try {
      const health = await embeddingsApi.getHealth()
      setVectorHealth(health)
    } catch {
      // Embeddings may not be configured — that's fine
    }
  }, [])

  const handleVectorOptimize = useCallback(async () => {
    setVectorBusy('Compacting & rebuilding...')
    try {
      await embeddingsApi.optimize()
      await refreshVectorHealth()
      addToast({ type: 'success', message: 'Vector store optimized.' })
    } catch {
      addToast({ type: 'error', message: 'Vector store optimization failed.' })
    } finally {
      setVectorBusy(null)
    }
  }, [addToast, refreshVectorHealth])

  const handleVectorReset = useCallback(async () => {
    setVectorBusy('Resetting...')
    try {
      await embeddingsApi.forceReset()
      await refreshVectorHealth()
      addToast({ type: 'success', message: 'Vector store reset. It will reinitialize on next use.' })
    } catch {
      addToast({ type: 'error', message: 'Vector store reset failed.' })
    } finally {
      setVectorBusy(null)
    }
  }, [addToast, refreshVectorHealth])

  // Fetch status on mount and every 30s
  useEffect(() => {
    let mounted = true
    const fetchStatus = async () => {
      const [s] = await Promise.all([refreshStatus(), refreshDatabase(), refreshVectorHealth()])
      if (mounted && s) setLoading(false)
      else if (mounted) setLoading(false)
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [refreshDatabase, refreshStatus, refreshVectorHealth])

  // Tick uptime every second (paused while reconnecting or shut down)
  useEffect(() => {
    if (reconnecting || isShutdown) return
    const interval = setInterval(() => setUptime((u) => u + 1000), 1000)
    return () => clearInterval(interval)
  }, [reconnecting, isShutdown])

  // ── WS disconnect / reconnect detection ─────────────────────────────────

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

      // Re-fetch status (new PID, uptime reset, possibly new branch/version)
      refreshStatus()
      refreshDatabase()

      // Re-subscribe to log streaming
      operatorApi.subscribeLogs().catch(() => {})
    })

    return () => {
      clearInterval(disconnectPoll)
      unsub()
    }
  }, [reconnecting, refreshDatabase, refreshStatus])

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
      title: 'Apply Update',
      message: `This will pull the latest changes (${status?.commitsBehind ?? 0} commits), reinstall dependencies, rebuild the frontend, and restart the server. Your browser will temporarily disconnect.`,
      variant: 'warning',
      confirmText: 'Update & Restart',
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('updating')
        try {
          await operatorApi.applyUpdate()
        } catch { /* server will restart */ }
      },
    })
  }, [status?.commitsBehind, startRestartOperation])

  const handleSwitchBranch = useCallback((target: string) => {
    setConfirm({
      title: 'Switch Branch',
      message: `Switch to the "${target}" branch? This will checkout, pull, reinstall, rebuild, and restart the server.`,
      variant: 'warning',
      confirmText: `Switch to ${target}`,
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('switching branch')
        try {
          await operatorApi.switchBranch(target)
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation])

  const handleRestart = useCallback(() => {
    setConfirm({
      title: 'Restart Server',
      message: 'Restart the Lumiverse server? Your browser will temporarily disconnect and reconnect automatically.',
      variant: 'warning',
      confirmText: 'Restart',
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('restarting')
        try {
          await operatorApi.restart()
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation])

  const handleShutdown = useCallback(() => {
    setConfirm({
      title: 'Shut Down Server',
      message: (
        <>
          <p>This will completely stop the Lumiverse server and runner. You will need to restart manually from the terminal.</p>
          <p style={{ marginTop: 8, fontWeight: 500 }}>This action cannot be undone from the web interface.</p>
        </>
      ),
      variant: 'danger',
      confirmText: 'Shut Down',
      onConfirm: async () => {
        setConfirm(null)
        setIsShutdown(true)
        setBusy('shutting down')
        try {
          await operatorApi.shutdown()
        } catch { /* expected — server is going down */ }
      },
    })
  }, [])

  const handleToggleRemote = useCallback((enable: boolean) => {
    if (enable) {
      setConfirm({
        title: 'Enable Remote Mode',
        message: (
          <>
            <p>Remote mode allows connections from any origin. This is intended for accessing Lumiverse from other devices on your network or remotely.</p>
            <p style={{ marginTop: 8 }}>Enabling remote mode exposes your Lumiverse instance to any device that can reach this server. Only enable this if you understand the security implications and trust your network.</p>
            <p style={{ marginTop: 8 }}>The server will restart to apply this change.</p>
          </>
        ),
        variant: 'danger',
        confirmText: 'Enable Remote Mode',
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
  }, [startRestartOperation])

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
      title: 'Rebuild Frontend',
      message: 'This will delete the frontend build, rebuild it from source, and restart the server. Your browser will temporarily disconnect.',
      variant: 'warning',
      confirmText: 'Rebuild & Restart',
      onConfirm: async () => {
        setConfirm(null)
        startRestartOperation('rebuilding frontend')
        try {
          await operatorApi.rebuildFrontend()
        } catch { /* server will restart */ }
      },
    })
  }, [startRestartOperation])

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
      addToast({ type: 'success', message: 'Database tuning refreshed and optimize completed.' })
    } catch {
      addToast({ type: 'error', message: 'Database maintenance failed.' })
    }
    setBusy(null)
  }, [addToast, dbTuning, refreshDatabase])

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

  const handleRunVacuumNow = useCallback(() => {
    const normalizedTuning = normalizeDatabaseTuning(dbTuning)
    const normalizedMaintenance = normalizeDatabaseMaintenance(dbMaintenanceSettings)
    setConfirm({
      title: 'Run Vacuum Now',
      message: (
        <>
          <p>This will checkpoint the WAL, rewrite the SQLite database, reclaim free pages, run ANALYZE, and finish with PRAGMA optimize.</p>
          <p style={{ marginTop: 8 }}>
            Estimated scratch space needed: <strong>{formatBytes(dbStatus?.stats?.vacuumEstimatedRequiredBytes ?? 0)}</strong>
            {' · '}
            currently free: <strong>{formatBytes(dbStatus?.stats?.filesystemFreeBytes ?? 0)}</strong>
          </p>
          <p style={{ marginTop: 8 }}>
            Reclaimable space right now: <strong>{formatBytes(dbStatus?.stats?.freeBytes ?? 0)}</strong>
            {' · '}
            active generations: <strong>{dbStatus?.automaticMaintenance?.activeGenerationCount ?? 0}</strong>
          </p>
          <p style={{ marginTop: 8, opacity: 0.85 }}>
            This can block writes while the file is rebuilt. Run it when the server is otherwise quiet.
          </p>
        </>
      ),
      variant: 'warning',
      confirmText: 'Vacuum Database',
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
          addToast({ type: 'success', message: 'SQLite VACUUM completed successfully.' })
        } catch (err) {
          addToast({ type: 'error', message: err instanceof Error ? err.message : 'VACUUM failed.' })
        }
        setBusy(null)
      },
    })
  }, [addToast, dbMaintenanceSettings, dbStatus, dbTuning, refreshDatabase])

  const handleRefreshDatabase = useCallback(async () => {
    setBusy('refreshing database stats')
    try {
      await refreshDatabase()
    } finally {
      setBusy(null)
    }
  }, [refreshDatabase])

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={styles.container}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lumiverse-text-dim)', fontSize: 13 }}>
          <Loader2 size={16} className={spinClass} /> Loading operator status...
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
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Server shut down</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Lumiverse has been stopped. Restart it from the terminal to continue.</div>
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

  return (
    <div className={styles.container}>
      {/* Status Grid */}
      <div className={styles.statusGrid}>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>Port</span>
          <span className={styles.statusValue}>{status?.port ?? '—'}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>PID</span>
          <span className={styles.statusValue}>{status?.pid ?? '—'}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>Uptime</span>
          <span className={styles.statusValue}>{formatUptime(uptime)}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>Branch</span>
          <span className={styles.statusValue}>{currentBranch}</span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>Version</span>
          <span className={styles.statusValue}>
            {status?.version ?? '—'}
            {status?.commit ? <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 4 }}>({status.commit})</span> : null}
          </span>
        </div>
        <div className={styles.statusCard}>
          <span className={styles.statusLabel}>Runner IPC</span>
          <span className={clsx(styles.ipcBadge, ipcAvailable ? styles.ipcAvailable : styles.ipcUnavailable)}>
            {ipcAvailable ? 'Connected' : 'Unavailable'}
          </span>
        </div>
      </div>

      {/* Update badge */}
      {status?.updateAvailable && (
        <div className={styles.updateBadge}>
          <Download size={12} />
          {status.commitsBehind} update{status.commitsBehind > 1 ? 's' : ''} available
          {status.latestUpdateMessage ? ` — ${status.latestUpdateMessage}` : ''}
        </div>
      )}

      {/* Reconnecting banner */}
      {reconnecting && (
        <div className={styles.reconnectBanner}>
          <Loader2 size={16} className={spinClass} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Reconnecting to server...</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>The server is restarting. This page will refresh automatically once it's back.</div>
          </div>
        </div>
      )}

      {/* Busy indicator (non-reconnect operations) */}
      {effectiveBusy && effectiveBusy !== 'reconnecting' && (
        <div className={styles.busyOverlay}>
          <Loader2 size={16} className={spinClass} />
          {effectiveBusy === 'checking' ? 'Checking for updates...' :
           effectiveBusy === 'updating' ? 'Applying update... Server will restart.' :
           effectiveBusy === 'switching branch' ? 'Switching branch... Server will restart.' :
           effectiveBusy === 'restarting' ? 'Restarting server...' :
           effectiveBusy === 'shutting down' ? 'Shutting down...' :
           effectiveBusy === 'toggling remote' ? 'Toggling remote mode... Server will restart.' :
           effectiveBusy === 'clearing cache' ? 'Clearing package cache...' :
           effectiveBusy === 'installing dependencies' ? 'Installing dependencies...' :
           effectiveBusy === 'saving database tuning' ? 'Saving database tuning...' :
           effectiveBusy === 'saving database maintenance' ? 'Saving database maintenance...' :
           effectiveBusy === 'refreshing database stats' ? 'Refreshing database stats...' :
            effectiveBusy === 'database maintenance' ? 'Running database maintenance...' :
           effectiveBusy === 'database vacuum' ? 'Running SQLite VACUUM...' :
            effectiveBusy === 'rebuilding frontend' ? 'Rebuilding frontend... Server will restart.' :
            `${effectiveBusy}...`}
        </div>
      )}

      {/* Controls */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Server Controls</span>
        </div>
        <div className={styles.sectionBody}>
          {!ipcAvailable && (
            <div className={styles.disabledHint}>
              Runner IPC not available. Start Lumiverse with ./start.sh or bun run runner to enable server controls.
            </div>
          )}
          <div className={styles.controls}>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleCheckUpdate}
            >
              <RefreshCw size={14} />
              Check for Updates
            </button>
            {status?.updateAvailable && (
              <button
                className={styles.controlBtnPrimary}
                disabled={!ipcAvailable || !!effectiveBusy}
                onClick={handleApplyUpdate}
              >
                <Download size={14} />
                Apply Update
              </button>
            )}
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={() => handleSwitchBranch(otherBranch)}
            >
              <GitBranch size={14} />
              Switch to {otherBranch}
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleRestart}
            >
              <Power size={14} />
              Restart Server
            </button>
            <button
              className={styles.controlBtnDanger}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleShutdown}
            >
              <PowerOff size={14} />
              Shut Down
            </button>
          </div>
        </div>
      </div>

      {/* Maintenance */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Maintenance</span>
        </div>
        <div className={styles.sectionBody}>
          {!ipcAvailable && (
            <div className={styles.disabledHint}>
              Runner IPC not available. Start Lumiverse with ./start.sh or bun run runner to enable maintenance tools.
            </div>
          )}
          <div className={styles.controls}>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleClearCache}
            >
              <HardDrive size={14} />
              Clear Package Cache
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleEnsureDeps}
            >
              <PackageCheck size={14} />
              Ensure Dependencies
            </button>
            <button
              className={styles.controlBtn}
              disabled={!ipcAvailable || !!effectiveBusy}
              onClick={handleRebuildFrontend}
            >
              <Hammer size={14} />
              Rebuild Frontend
            </button>
          </div>
        </div>
      </div>

      {/* Remote Mode */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Remote Access</span>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.remoteRow}>
            <div className={styles.remoteInfo}>
              <span className={styles.remoteLabel}>
                {status?.remoteMode ? <Wifi size={14} style={{ marginRight: 6 }} /> : <WifiOff size={14} style={{ marginRight: 6, opacity: 0.5 }} />}
                Remote Mode
              </span>
              <span className={styles.remoteHint}>
                {status?.remoteMode
                  ? 'Connections accepted from any origin. Disable when not needed.'
                  : 'Only local and LAN connections are accepted.'}
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

      {/* Database */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Database</span>
        </div>
        <div className={styles.sectionBody}>
          {dbStats && (
            <div className={styles.statusGrid}>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>DB File</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.fileBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>WAL</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.walBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>Live Pages</span>
                <span className={styles.statusValue}>{dbStats.pageCount.toLocaleString()}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>Freelist</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.freeBytes)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>Cache</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.cacheBytesApprox)}</span>
              </div>
              <div className={styles.statusCard}>
                <span className={styles.statusLabel}>mmap</span>
                <span className={styles.statusValue}>{formatBytes(dbStats.mmapSize)}</span>
              </div>
            </div>
          )}

          <div className={styles.dbInfoGrid}>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>Path</span>
              <span className={styles.dbMono}>{dbStats?.path ?? '—'}</span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>Pragmas</span>
              <span className={styles.dbInlineText}>
                journal={dbStats?.journalMode ?? '—'} · sync={dbStats?.synchronous ?? '—'} · temp={dbStats?.tempStore ?? '—'} · checkpoint={dbStats?.walAutocheckpoint ?? '—'}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>Resolved Tuning</span>
              <span className={styles.dbInlineText}>
                cache {effectiveTuning ? `${formatBytes(effectiveTuning.cacheBytes)} (${effectiveTuning.cacheSource})` : '—'}
                {' · '}
                mmap {effectiveTuning ? `${formatBytes(effectiveTuning.mmapSizeBytes)} (${effectiveTuning.mmapSource})` : '—'}
                {' · '}
                journal cap {effectiveTuning ? formatBytes(effectiveTuning.journalSizeLimitBytes) : '—'}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>Disk Headroom</span>
              <span className={styles.dbInlineText}>
                free {formatBytes(dbStats?.filesystemFreeBytes ?? 0)}
                {' · '}
                vacuum needs about {formatBytes(dbStats?.vacuumEstimatedRequiredBytes ?? 0)}
                {' · '}
                {dbStats?.vacuumHasEnoughFreeBytes === null
                  ? 'filesystem free space unknown'
                  : dbStats?.vacuumHasEnoughFreeBytes
                    ? 'enough free space detected'
                    : 'not enough free space for a safe vacuum'}
              </span>
            </div>
          </div>

          {vacuumDiskWarning && (
            <div className={styles.warningBanner}>
              SQLite VACUUM is currently unsafe: estimated rewrite headroom is {formatBytes(dbStats?.vacuumEstimatedRequiredBytes ?? 0)}, but only {formatBytes(dbStats?.filesystemFreeBytes ?? 0)} appears free on this volume.
            </div>
          )}

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Cache % of host RAM</span>
              <input
                type="number"
                min={0.1}
                max={50}
                step={0.1}
                className={styles.fieldInput}
                placeholder="Auto"
                value={dbTuning.cacheMemoryPercent ?? ''}
                onChange={(e) => setDbTuning((prev) => ({
                  ...prev,
                  cacheMemoryPercent: e.target.value === '' ? null : parseFloat(e.target.value),
                }))}
              />
              <span className={styles.fieldHint}>
                Blank uses the automatic cache target. Current recommendation: {effectiveTuning ? formatBytes(effectiveTuning.cacheBytes) : '—'}.
              </span>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>mmap size (MiB)</span>
              <input
                type="number"
                min={0}
                step={16}
                className={styles.fieldInput}
                placeholder={mmapSupported ? 'Auto' : 'Disabled on Windows'}
                disabled={!mmapSupported}
                value={dbTuning.mmapSizeBytes == null ? '' : Math.round(dbTuning.mmapSizeBytes / (1024 * 1024))}
                onChange={(e) => setDbTuning((prev) => ({
                  ...prev,
                  mmapSizeBytes: e.target.value === '' ? null : parseInt(e.target.value, 10) * 1024 * 1024,
                }))}
              />
              <span className={styles.fieldHint}>
                Linux/macOS only. Blank uses the automatic mmap target. Set `0` to disable mmap explicitly.
              </span>
            </label>
          </div>

          <div className={styles.dbInfoGrid}>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>Automatic Maintenance</span>
              <span className={styles.dbInlineText}>
                optimize {formatTimestamp(maintenanceState?.lastOptimizeAt)} · analyze {formatTimestamp(maintenanceState?.lastAnalyzeAt)} · vacuum {formatTimestamp(maintenanceState?.lastVacuumAt)}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>Auto Vacuum Status</span>
              <span className={styles.dbInlineText}>
                {autoMaintenance?.vacuum.eligible
                  ? 'Eligible to run on the next scheduler pass.'
                  : autoMaintenance?.vacuum.blockedReasons.length
                    ? autoMaintenance.vacuum.blockedReasons.join(' · ')
                    : 'Automatic vacuum is idle.'}
              </span>
            </div>
            <div className={styles.dbInfoBlock}>
              <span className={styles.fieldLabel}>Idle Signals</span>
              <span className={styles.dbInlineText}>
                visible sessions {autoMaintenance?.visibility.visibleSessions ?? 0}/{autoMaintenance?.visibility.totalSessions ?? 0}
                {' · '}
                hidden for {autoMaintenance?.visibility.hiddenIdleMinutes ?? 0} min
                {' · '}
                last write {autoMaintenance?.lastWriteIdleMinutes == null ? '—' : `${autoMaintenance.lastWriteIdleMinutes} min ago`}
                {' · '}
                active generations {autoMaintenance?.activeGenerationCount ?? 0}
              </span>
            </div>
          </div>

          <div className={styles.tuningGrid}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Optimize interval (hours)</span>
              <input
                type="number"
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder="Disabled"
                value={dbMaintenanceSettings.optimizeIntervalHours ?? ''}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  optimizeIntervalHours: e.target.value === '' ? null : parseInt(e.target.value, 10),
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Analyze interval (hours)</span>
              <input
                type="number"
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder="Disabled"
                value={dbMaintenanceSettings.analyzeIntervalHours ?? ''}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  analyzeIntervalHours: e.target.value === '' ? null : parseInt(e.target.value, 10),
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Auto vacuum interval (hours)</span>
              <input
                type="number"
                min={1}
                step={1}
                className={styles.fieldInput}
                placeholder="Disabled"
                value={dbMaintenanceSettings.vacuumIntervalHours ?? ''}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumIntervalHours: e.target.value === '' ? null : parseInt(e.target.value, 10),
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Vacuum idle time (minutes)</span>
              <input
                type="number"
                min={1}
                step={1}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinIdleMinutes ?? 15}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinIdleMinutes: parseInt(e.target.value, 10),
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Min reclaimable space (MiB)</span>
              <input
                type="number"
                min={0}
                step={64}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinReclaimBytes == null ? '' : Math.round(dbMaintenanceSettings.vacuumMinReclaimBytes / (1024 * 1024))}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinReclaimBytes: e.target.value === '' ? 0 : parseInt(e.target.value, 10) * 1024 * 1024,
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Min reclaim percent</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinReclaimPercent ?? 15}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinReclaimPercent: parseInt(e.target.value, 10),
                }))}
              />
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Min DB size (MiB)</span>
              <input
                type="number"
                min={0}
                step={256}
                className={styles.fieldInput}
                value={dbMaintenanceSettings.vacuumMinDbSizeBytes == null ? '' : Math.round(dbMaintenanceSettings.vacuumMinDbSizeBytes / (1024 * 1024))}
                onChange={(e) => setDbMaintenanceSettings((prev) => ({
                  ...prev,
                  vacuumMinDbSizeBytes: e.target.value === '' ? 0 : parseInt(e.target.value, 10) * 1024 * 1024,
                }))}
              />
            </label>
          </div>

          <div className={styles.toggleRow}>
            <div className={styles.remoteInfo}>
              <span className={styles.remoteLabel}>Enable automatic vacuum</span>
              <span className={styles.remoteHint}>Runs only when the interval, idle, and reclaim thresholds are all satisfied.</span>
            </div>
            <Toggle.Switch
              checked={dbMaintenanceSettings.autoVacuumEnabled ?? false}
              onChange={(checked) => setDbMaintenanceSettings((prev) => ({ ...prev, autoVacuumEnabled: checked }))}
              disabled={!!effectiveBusy}
            />
          </div>

          <div className={styles.toggleGrid}>
            <div className={styles.toggleRowCompact}>
              <span className={styles.remoteHint}>Require no visible clients</span>
              <Toggle.Switch
                checked={dbMaintenanceSettings.vacuumRequireNoVisibleClients !== false}
                onChange={(checked) => setDbMaintenanceSettings((prev) => ({ ...prev, vacuumRequireNoVisibleClients: checked }))}
                disabled={!!effectiveBusy}
              />
            </div>
            <div className={styles.toggleRowCompact}>
              <span className={styles.remoteHint}>Require no active generations</span>
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
              Refresh DB Stats
            </button>
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleSaveDatabaseTuning}>
              <HardDrive size={14} />
              Save Tuning
            </button>
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleSaveDatabaseMaintenance}>
              <HardDrive size={14} />
              Save Auto Maintenance
            </button>
            <button className={styles.controlBtnPrimary} disabled={!!effectiveBusy} onClick={handleRunDatabaseMaintenance}>
              <Hammer size={14} />
              Apply Tuning + Optimize
            </button>
            <button className={styles.controlBtnDanger} disabled={!!effectiveBusy || vacuumDiskWarning} onClick={handleRunVacuumNow}>
              <Hammer size={14} />
              Run Vacuum Now
            </button>
          </div>
        </div>
      </div>

      {/* LanceDB Vector Store */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Vector Store (LanceDB)</span>
        </div>
        <div className={styles.sectionBody}>
          {vectorHealth ? (
            vectorHealth.exists ? (
              <>
                <div className={styles.statusGrid}>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>Rows</span>
                    <span className={styles.statusValue}>{vectorHealth.rowCount.toLocaleString()}</span>
                  </div>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>Vector Index</span>
                    <span className={styles.statusValue}>{vectorHealth.vectorIndexReady ? 'Active' : 'Pending'}</span>
                  </div>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>Scalar Indexes</span>
                    <span className={styles.statusValue}>{vectorHealth.scalarIndexReady ? 'Active' : 'Pending'}</span>
                  </div>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>FTS Index</span>
                    <span className={styles.statusValue}>{vectorHealth.ftsIndexReady ? 'Active' : 'Pending'}</span>
                  </div>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>Unindexed Rows</span>
                    <span className={styles.statusValue}>{vectorHealth.unindexedRowEstimate.toLocaleString()}</span>
                  </div>
                  <div className={styles.statusCard}>
                    <span className={styles.statusLabel}>Indexes</span>
                    <span className={styles.statusValue}>{vectorHealth.indexes.length}</span>
                  </div>
                </div>

                {vectorHealth.indexes.length > 0 && (
                  <div className={styles.dbInfoGrid}>
                    <div className={styles.dbInfoBlock}>
                      <span className={styles.statusLabel}>Index Details</span>
                      <span className={styles.dbInlineText}>
                        {vectorHealth.indexes.map((idx) =>
                          idx.type ? `${idx.name} (${idx.type})` : idx.name
                        ).join(' · ')}
                      </span>
                    </div>
                    {vectorHealth.lastIndexRebuildAt > 0 && (
                      <div className={styles.dbInfoBlock}>
                        <span className={styles.statusLabel}>Last Index Rebuild</span>
                        <span className={styles.dbInlineText}>
                          {new Date(vectorHealth.lastIndexRebuildAt).toLocaleString()}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.disabledHint}>
                No vector store initialized. It will be created automatically when embeddings are first used.
              </div>
            )
          ) : (
            <div className={styles.disabledHint}>Loading vector store status...</div>
          )}

          <div className={styles.controls}>
            <button className={styles.controlBtn} disabled={!!vectorBusy} onClick={refreshVectorHealth}>
              <RefreshCw size={14} />
              Refresh
            </button>
            <button
              className={styles.controlBtnPrimary}
              disabled={!!vectorBusy || !vectorHealth?.exists}
              onClick={handleVectorOptimize}
            >
              {vectorBusy === 'Compacting & rebuilding...'
                ? <Loader2 size={14} className={spinClass} />
                : <Hammer size={14} />}
              Compact + Rebuild Index
            </button>
            <button
              className={styles.controlBtnDanger}
              disabled={!!vectorBusy || !vectorHealth?.exists}
              onClick={() => setConfirm({
                title: 'Reset Vector Store',
                message: 'This will delete the entire LanceDB directory, clear all cached embeddings, and reset vectorization flags. The vector store will reinitialize automatically on next use.',
                variant: 'danger',
                confirmText: 'Reset Vector Store',
                onConfirm: async () => {
                  setConfirm(null)
                  await handleVectorReset()
                },
              })}
            >
              {vectorBusy === 'Resetting...'
                ? <Loader2 size={14} className={spinClass} />
                : <Trash2 size={14} />}
              Force Reset
            </button>
          </div>
        </div>
      </div>

      {/* Log Viewer */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Server Logs</span>
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
