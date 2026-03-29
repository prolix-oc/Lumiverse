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
import { operatorApi, type OperatorStatus } from '@/api/operator'
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
  const [uptime, setUptime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [isShutdown, setIsShutdown] = useState(false)
  const storeBusy = useStore((s) => s.operatorBusy)

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

  // Fetch status on mount and every 30s
  useEffect(() => {
    let mounted = true
    const fetchStatus = async () => {
      const s = await refreshStatus()
      if (mounted && s) setLoading(false)
      else if (mounted) setLoading(false)
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [refreshStatus])

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

      // Re-subscribe to log streaming
      operatorApi.subscribeLogs().catch(() => {})
    })

    return () => {
      clearInterval(disconnectPoll)
      unsub()
    }
  }, [reconnecting, refreshStatus])

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
