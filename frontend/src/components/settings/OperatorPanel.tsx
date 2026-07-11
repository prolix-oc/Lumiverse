import { useEffect, useRef, useState, useCallback, useMemo, type SetStateAction } from 'react'
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
  type DiskWarningSettings,
  type DatabaseMaintenanceSettings,
  operatorApi,
  type DatabaseTuningSettings,
  type DnsSettings,
  type OperatorDatabaseStatus,
  type OperatorDiskWarningStatus,
  type OperatorDnsStatus,
  type OperatorSharpStatus,
  type OperatorSmartctlStatus,
  type OperatorStatus,
  type SharpSettings,
  type SmartDriveStatus,
  type TrustedHostEntry,
  type TrustedHostsResponse,
} from '@/api/operator'
import { settingsApi } from '@/api/settings'
import { ApiError } from '@/api/client'
import {
  embeddingsApi,
  type UpdateVectorStoreConfigInput,
  type VectorStoreConfigStatus,
  type VectorStoreHealth,
  type VectorStoreProviderId,
  type VectorStoreTuningProfile,
  type VectorStoreTestResult,
} from '@/api/embeddings'
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

function formatIsoTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return '—'
  const value = new Date(timestamp)
  return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString()
}

function formatSmartNumber(value: number | null): string {
  return value == null ? '—' : value.toLocaleString()
}

function smartStatusTranslationKey(status: SmartDriveStatus): string {
  const keys: Record<SmartDriveStatus, string> = {
    ok: 'operator.smartStatusOk',
    warning: 'operator.smartStatusWarning',
    failing: 'operator.smartStatusFailing',
    unavailable: 'operator.smartStatusUnavailable',
    standby: 'operator.smartStatusStandby',
  }
  return keys[status]
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

function vectorProviderLabel(provider: VectorStoreHealth['provider'] | undefined): string {
  switch (provider) {
    case 'qdrant': return 'Qdrant'
    case 'milvus': return 'Milvus'
    case 'lancedb': return 'LanceDB'
    default: return 'Unknown'
  }
}

function vectorScoreLabel(kind: VectorStoreHealth['capabilities'] extends infer C ? C extends { scoreKind: infer K } ? K : never : never): string {
  return kind === 'cosine_distance' ? 'cosine distance' : 'cosine similarity'
}

const DEFAULT_MILVUS_HYBRID_CANDIDATE_MULTIPLIER = 3
const DEFAULT_MILVUS_HYBRID_CANDIDATE_CAP = 200

interface VectorStoreDraft {
  provider: VectorStoreProviderId
  tuningProfile: VectorStoreTuningProfile
  qdrantUrl: string
  qdrantCollectionPrefix: string
  milvusAddress: string
  milvusDatabase: string
  milvusUsername: string
  milvusSsl: boolean
  milvusTransport: 'grpc' | 'http'
  milvusConnectTimeoutMs: number
  milvusRequestTimeoutMs: number
  milvusHybridCandidateMultiplier: number
  milvusHybridCandidateCap: number
}

function vectorDraftFromConfig(config: VectorStoreConfigStatus | null): VectorStoreDraft {
  return {
    provider: config?.provider ?? 'lancedb',
    tuningProfile: config?.tuningProfile ?? 'balanced',
    qdrantUrl: config?.qdrant?.url ?? '',
    qdrantCollectionPrefix: config?.qdrant?.collectionPrefix ?? 'lumiverse_',
    milvusAddress: config?.milvus?.address ?? '',
    milvusDatabase: config?.milvus?.database ?? '',
    milvusUsername: config?.milvus?.username ?? '',
    milvusSsl: config?.milvus?.ssl ?? false,
    milvusTransport: config?.milvus?.transport ?? 'grpc',
    milvusConnectTimeoutMs: config?.milvus?.connectTimeoutMs ?? 5000,
    milvusRequestTimeoutMs: config?.milvus?.requestTimeoutMs ?? 60000,
    milvusHybridCandidateMultiplier: config?.milvusHybridSearch?.candidateMultiplier ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_MULTIPLIER,
    milvusHybridCandidateCap: config?.milvusHybridSearch?.candidateCap ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_CAP,
  }
}

function vectorDraftToPayload(
  draft: VectorStoreDraft,
  qdrantApiKey: string,
  milvusPassword: string,
): UpdateVectorStoreConfigInput {
  const payload: UpdateVectorStoreConfigInput = { provider: draft.provider, tuningProfile: draft.tuningProfile }
  const trimmedQdrantKey = qdrantApiKey.trim()
  const trimmedMilvusPassword = milvusPassword.trim()

  if (draft.provider === 'qdrant') {
    payload.qdrant = {
      url: draft.qdrantUrl.trim(),
      collectionPrefix: draft.qdrantCollectionPrefix.trim() || undefined,
    }
    if (trimmedQdrantKey) payload.qdrant_api_key = trimmedQdrantKey
  }

  if (draft.provider === 'milvus') {
    payload.milvus = {
      address: draft.milvusAddress.trim(),
      database: draft.milvusDatabase.trim() || undefined,
      username: draft.milvusUsername.trim() || undefined,
      ssl: draft.milvusSsl,
      transport: draft.milvusTransport,
      connectTimeoutMs: Math.max(1000, Math.min(60000, Math.round(draft.milvusConnectTimeoutMs))),
      requestTimeoutMs: Math.max(0, Math.min(300000, Math.round(draft.milvusRequestTimeoutMs))),
    }
    payload.milvusHybridSearch = {
      candidateMultiplier: Math.max(1, Math.min(10, Math.round(draft.milvusHybridCandidateMultiplier))),
      candidateCap: Math.max(1, Math.min(2000, Math.round(draft.milvusHybridCandidateCap))),
    }
    if (trimmedMilvusPassword) payload.milvus_password = trimmedMilvusPassword
  }

  return payload
}

function vectorTuningProfileHint(profile: VectorStoreTuningProfile): string {
  switch (profile) {
    case 'low_latency': return 'More RAM/index work for lower query latency.'
    case 'low_memory': return 'Lower memory footprint with on-disk/IVF-style tradeoffs.'
    case 'bulk_reindex': return 'Faster backfills; switch back after reindexing for normal live recall.'
    case 'balanced':
    default: return 'Safe default for mixed live chat, world books, and Memory Cortex.'
  }
}

function vectorStoreErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; message?: unknown } | undefined
    if (typeof body?.error === 'string' && body.error.trim()) return body.error
    if (typeof body?.message === 'string' && body.message.trim()) return body.message
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function vectorStoreTestResultFromError(err: unknown, provider: VectorStoreProviderId): VectorStoreTestResult | null {
  if (!(err instanceof ApiError)) return null
  const body = err.body as Partial<VectorStoreTestResult> | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.ok !== 'boolean') return null
  return {
    ok: body.ok,
    provider: body.provider ?? provider,
    error: typeof body.error === 'string' ? body.error : undefined,
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

function normalizeDiskWarningSettings(input: DiskWarningSettings): DiskWarningSettings {
  const usagePercentThreshold = input.usagePercentThreshold == null || !Number.isFinite(input.usagePercentThreshold)
    ? null
    : Math.max(0.01, Math.min(1, input.usagePercentThreshold))
  const minFreeBytesThreshold = input.minFreeBytesThreshold == null || !Number.isFinite(input.minFreeBytesThreshold)
    ? null
    : Math.max(0, Math.floor(input.minFreeBytesThreshold))
  return { usagePercentThreshold, minFreeBytesThreshold }
}

function formatThresholdPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const pct = value * 100
  return Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)
}

function formatGiBValue(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  const gib = bytes / (1024 * 1024 * 1024)
  return Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)
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
type VectorConfigBusyOp = 'testing' | 'switching' | 'saving'

export default function OperatorPanel() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<OperatorStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [dbStatus, setDbStatus] = useState<OperatorDatabaseStatus | null>(null)
  const [dbTuning, setDbTuning] = useState<DatabaseTuningSettings>({ cacheMemoryPercent: null, mmapSizeBytes: null })
  const [dbMaintenanceSettings, setDbMaintenanceSettings] = useState<DatabaseMaintenanceSettings>({})
  const [diskWarningStatus, setDiskWarningStatus] = useState<OperatorDiskWarningStatus | null>(null)
  const [diskWarningSettings, setDiskWarningSettings] = useState<DiskWarningSettings>({})
  const [smartctlStatus, setSmartctlStatus] = useState<OperatorSmartctlStatus | null>(null)
  const [smartctlError, setSmartctlError] = useState<string | null>(null)
  const [smartctlRefreshing, setSmartctlRefreshing] = useState(false)
  const [smartctlInstalling, setSmartctlInstalling] = useState(false)
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
  const [vectorConfig, setVectorConfig] = useState<VectorStoreConfigStatus | null>(null)
  const [vectorDraft, setVectorDraft] = useState<VectorStoreDraft>(() => vectorDraftFromConfig(null))
  const [qdrantApiKeyDraft, setQdrantApiKeyDraft] = useState('')
  const [milvusPasswordDraft, setMilvusPasswordDraft] = useState('')
  const [vectorConfigBusy, setVectorConfigBusy] = useState<VectorConfigBusyOp | null>(null)
  const [vectorTestResult, setVectorTestResult] = useState<VectorStoreTestResult | null>(null)
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
  const vectorDraftDirty = useRef(false)

  const normalizedStoreBusy = normalizeOperatorOperation(storeBusy)
  const effectiveBusy = reconnecting ? 'reconnecting' : (normalizedStoreBusy || normalizeOperatorOperation(busy))
  const effectiveBusyMessage = !reconnecting && normalizedStoreBusy && storeProgressMessage
    ? storeProgressMessage
    : null
  const ipcAvailable = status?.ipcAvailable ?? false
  const vectorProvider = vectorProviderLabel(vectorHealth?.provider)
  const vectorCapabilities = vectorHealth?.capabilities
  const vectorSupportsOptimize = vectorCapabilities?.supportsOptimize !== false
  const vectorSupportsLexical = vectorCapabilities?.nativeLexical === true
  const vectorIsExternal = vectorCapabilities?.externalService === true
  const vectorConfigManagedByEnv = vectorConfig?.managedByEnv === true
  const vectorMilvusCandidateMultiplier = vectorConfig?.milvusHybridSearch?.candidateMultiplier ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_MULTIPLIER
  const vectorMilvusCandidateCap = vectorConfig?.milvusHybridSearch?.candidateCap ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_CAP
  const vectorRuntimeTuningChanged = !!vectorConfig && (
    vectorDraft.tuningProfile !== (vectorConfig.tuningProfile ?? 'balanced')
    || (
      vectorDraft.provider === 'milvus'
      && (
        vectorDraft.milvusHybridCandidateMultiplier !== vectorMilvusCandidateMultiplier
        || vectorDraft.milvusHybridCandidateCap !== vectorMilvusCandidateCap
      )
    )
  )
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
      'saving disk warning settings': t('operator.busySavingDiskWarning'),
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

  const refreshDiskWarningSettings = useCallback(async () => {
    try {
      const next = await operatorApi.getDiskWarning()
      setDiskWarningStatus(next)
      setDiskWarningSettings({
        usagePercentThreshold: next.configuredSettings.usagePercentThreshold ?? null,
        minFreeBytesThreshold: next.configuredSettings.minFreeBytesThreshold ?? null,
      })
      return next
    } catch {
      return null
    }
  }, [])

  const refreshSmartctl = useCallback(async (force = false) => {
    try {
      const next = await operatorApi.getSmartctl(force)
      setSmartctlStatus(next)
      setSmartctlError(null)
      return next
    } catch (err) {
      setSmartctlError(err instanceof Error ? err.message : t('operator.smartRefreshFailed'))
      return null
    }
  }, [t])

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

  const refreshVectorConfig = useCallback(async (resetDraft = false) => {
    try {
      const config = await embeddingsApi.getVectorStoreConfig()
      setVectorConfig(config)
      if (resetDraft || !vectorDraftDirty.current) {
        vectorDraftDirty.current = false
        setVectorDraft(vectorDraftFromConfig(config))
        setVectorTestResult(null)
        setQdrantApiKeyDraft('')
        setMilvusPasswordDraft('')
      }
      return config
    } catch {
      return null
    }
  }, [])

  const updateVectorDraft = useCallback((value: SetStateAction<VectorStoreDraft>) => {
    vectorDraftDirty.current = true
    setVectorDraft(value)
  }, [])

  const handleVectorProviderChange = useCallback((provider: VectorStoreProviderId) => {
    updateVectorDraft((prev) => ({ ...prev, provider }))
    setVectorTestResult(null)
  }, [updateVectorDraft])

  const handleVectorTest = useCallback(async () => {
    setVectorConfigBusy('testing')
    setVectorTestResult(null)
    try {
      const result = await embeddingsApi.testVectorStore(vectorDraftToPayload(vectorDraft, qdrantApiKeyDraft, milvusPasswordDraft))
      setVectorTestResult(result)
      addToast({ type: result.ok ? 'success' : 'error', message: result.ok ? 'Vector store connection OK' : (result.error || 'Vector store connection failed') })
    } catch (err) {
      const result = vectorStoreTestResultFromError(err, vectorDraft.provider)
      const message = result?.error || vectorStoreErrorMessage(err, 'Vector store connection failed')
      setVectorTestResult(result ?? { ok: false, provider: vectorDraft.provider, error: message })
      addToast({ type: 'error', message })
    } finally {
      setVectorConfigBusy(null)
    }
  }, [addToast, milvusPasswordDraft, qdrantApiKeyDraft, vectorDraft])

  const handleVectorSwitch = useCallback(async () => {
    setVectorConfigBusy('switching')
    setVectorTestResult(null)
    try {
      const result = await embeddingsApi.switchVectorStore(vectorDraftToPayload(vectorDraft, qdrantApiKeyDraft, milvusPasswordDraft))
      setVectorConfig(result)
      vectorDraftDirty.current = false
      setVectorDraft(vectorDraftFromConfig(result))
      setQdrantApiKeyDraft('')
      setMilvusPasswordDraft('')
      await refreshVectorHealth()
      addToast({
        type: 'success',
        message: result.reindexScheduled
          ? 'Vector store switched. Existing content was marked for reindexing.'
          : 'Vector store switched.',
      })
    } catch (err) {
      const message = vectorStoreErrorMessage(err, 'Failed to switch vector store')
      addToast({ type: 'error', message })
    } finally {
      setVectorConfigBusy(null)
    }
  }, [addToast, milvusPasswordDraft, qdrantApiKeyDraft, refreshVectorHealth, vectorDraft])

  const handleVectorSaveRuntimeTuning = useCallback(async () => {
    setVectorConfigBusy('saving')
    setVectorTestResult(null)
    try {
      const result = await embeddingsApi.updateVectorStoreConfig({
        tuningProfile: vectorDraft.tuningProfile,
        ...(vectorDraft.provider === 'milvus'
          ? {
              milvusHybridSearch: {
                candidateMultiplier: vectorDraft.milvusHybridCandidateMultiplier,
                candidateCap: vectorDraft.milvusHybridCandidateCap,
              },
            }
          : {}),
      })
      setVectorConfig(result)
      vectorDraftDirty.current = false
      setVectorDraft(vectorDraftFromConfig(result))
      await refreshVectorHealth()
      addToast({ type: 'success', message: 'Vector store runtime tuning saved.' })
    } catch (err) {
      const message = vectorStoreErrorMessage(err, 'Failed to save vector store runtime tuning')
      addToast({ type: 'error', message })
    } finally {
      setVectorConfigBusy(null)
    }
  }, [
    addToast,
    refreshVectorHealth,
    vectorDraft.milvusHybridCandidateCap,
    vectorDraft.milvusHybridCandidateMultiplier,
    vectorDraft.provider,
    vectorDraft.tuningProfile,
  ])

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
      await embeddingsApi.resetVectorStore()
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
      const [s] = await Promise.all([
        refreshStatus(),
        refreshDatabase(),
        refreshVectorHealth(),
        refreshVectorConfig(),
        refreshSharpSettings(),
        refreshDnsSettings(),
        refreshDiskWarningSettings(),
        refreshSmartctl(),
      ])
      if (mounted && s) setLoading(false)
      else if (mounted) setLoading(false)
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [refreshDatabase, refreshDiskWarningSettings, refreshDnsSettings, refreshSharpSettings, refreshSmartctl, refreshStatus, refreshVectorConfig, refreshVectorHealth])

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
      refreshDiskWarningSettings()
      refreshSharpSettings()
      refreshDnsSettings()
      refreshSmartctl()
      refreshTrustedHosts()

      // Re-subscribe to log streaming
      operatorApi.subscribeLogs().catch(() => {})
    })

    return () => {
      clearInterval(disconnectPoll)
      unsub()
    }
  }, [reconnecting, refreshDatabase, refreshDiskWarningSettings, refreshDnsSettings, refreshSharpSettings, refreshSmartctl, refreshStatus, refreshTrustedHosts])

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

  const handleSaveDiskWarningSettings = useCallback(async () => {
    setBusy('saving disk warning settings')
    try {
      const normalized = normalizeDiskWarningSettings(diskWarningSettings)
      const next = await operatorApi.putDiskWarning(normalized)
      setDiskWarningStatus(next)
      setDiskWarningSettings({
        usagePercentThreshold: next.configuredSettings.usagePercentThreshold ?? null,
        minFreeBytesThreshold: next.configuredSettings.minFreeBytesThreshold ?? null,
      })
      addToast({ type: 'success', message: t('operator.diskWarningApplySuccess') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : t('operator.diskWarningApplyFailed') })
    }
    setBusy(null)
  }, [addToast, diskWarningSettings, t])

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

  const handleRefreshSmartctl = useCallback(async () => {
    setSmartctlRefreshing(true)
    try {
      const next = await refreshSmartctl(true)
      if (!next) addToast({ type: 'error', message: t('operator.smartRefreshFailed') })
    } finally {
      setSmartctlRefreshing(false)
    }
  }, [addToast, refreshSmartctl, t])

  const handleInstallSmartctl = useCallback(async () => {
    setSmartctlInstalling(true)
    try {
      const result = await operatorApi.installSmartctl()
      setSmartctlStatus((prev) => prev ? { ...prev, ...result.status, snapshot: prev.snapshot } : null)
      if (result.installed) {
        addToast({ type: 'success', message: t('operator.smartInstallSuccess') })
        await refreshSmartctl(true)
      } else {
        setSmartctlError(result.error ?? t('operator.smartInstallFailed'))
      }
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null
      if (body && typeof body === 'object' && 'status' in body) {
        const result = body as { status?: Omit<OperatorSmartctlStatus, 'snapshot'>; error?: string }
        if (result.status) {
          setSmartctlStatus((prev) => prev ? { ...prev, ...result.status, snapshot: prev.snapshot } : prev)
        }
        setSmartctlError(result.error ?? t('operator.smartInstallFailed'))
      } else {
        setSmartctlError(err instanceof Error ? err.message : t('operator.smartInstallFailed'))
      }
    } finally {
      setSmartctlInstalling(false)
    }
  }, [addToast, refreshSmartctl, t])

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
  const smartSnapshot = smartctlStatus?.snapshot ?? smartctlStatus?.latestSnapshot

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

      {/* Disk Health */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('operator.diskHealth')}</span>
          <div className={styles.controls}>
            {smartctlStatus?.availability === 'installable' && (
              <button
                className={styles.controlBtnPrimary}
                disabled={smartctlInstalling || smartctlRefreshing}
                onClick={handleInstallSmartctl}
              >
                {smartctlInstalling ? <Loader2 size={14} className={spinClass} /> : <Download size={14} />}
                {smartctlInstalling ? t('operator.smartInstalling') : t('operator.smartInstall')}
              </button>
            )}
            <button
              className={styles.controlBtn}
              disabled={smartctlRefreshing || smartctlInstalling}
              onClick={handleRefreshSmartctl}
            >
              <RefreshCw size={14} className={smartctlRefreshing ? spinClass : undefined} />
              {t('operator.smartRefresh')}
            </button>
          </div>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.smartAvailability}>
            <span className={clsx(styles.smartAvailabilityDot, smartctlStatus?.availability === 'available' ? styles.smartOk : styles.smartUnavailable)} />
            <span>
              {smartctlStatus?.binary
                ? t('operator.smartAvailable', {
                  version: smartctlStatus.binary.version ? `v${smartctlStatus.binary.version}` : 'smartctl',
                  path: smartctlStatus.binary.path,
                })
                : smartctlStatus?.message ?? t('operator.smartLoading')}
            </span>
          </div>

          {smartctlError && <div className={styles.warningBanner}>{smartctlError}</div>}
          {smartctlStatus?.installPlan && (
            <span className={styles.fieldHint}>
              {t('operator.smartInstallCommand', { command: smartctlStatus.installPlan.command.join(' ') })}
            </span>
          )}
          {smartSnapshot?.error && <div className={styles.warningBanner}>{t('operator.smartCheckError', { error: smartSnapshot.error })}</div>}

          {smartSnapshot && !smartSnapshot.error && (
            <>
              <span className={styles.fieldHint}>{t('operator.smartLastChecked', { time: formatIsoTimestamp(smartSnapshot.checkedAt) })}</span>
              {smartSnapshot.drives.length === 0 ? (
                <div className={styles.disabledHint}>{t('operator.smartNoDrives')}</div>
              ) : (
                <div className={styles.smartDriveList}>
                  {smartSnapshot.drives.map((drive) => {
                    const ssd = drive.kind === 'ssd' ? drive.ssd : null
                    const hdd = drive.kind === 'hdd' ? drive.hdd : null
                    return (
                    <div className={styles.smartDrive} key={drive.device}>
                      <div className={styles.smartDriveHeader}>
                        <div>
                          <div className={styles.smartDriveName}>{drive.model ?? drive.device}</div>
                          <div className={styles.dbMono}>{drive.device}{drive.protocol ? ` · ${drive.protocol}` : ''}{drive.kind && drive.kind !== 'unknown' ? ` · ${drive.kind.toUpperCase()}` : ''}</div>
                        </div>
                        <span className={clsx(
                          styles.smartBadge,
                          drive.status === 'ok' && styles.smartOk,
                          drive.status === 'warning' && styles.smartWarning,
                          drive.status === 'failing' && styles.smartFailing,
                          (drive.status === 'unavailable' || drive.status === 'standby') && styles.smartUnavailable,
                        )}>
                          {t(smartStatusTranslationKey(drive.status))}
                        </span>
                      </div>

                      <div className={styles.smartMetrics}>
                        <div className={styles.smartMetric}>
                          <span>{t('operator.smartTemperature')}</span>
                          <strong>{drive.temperatureC == null ? '—' : t('operator.smartTemperatureValue', { value: drive.temperatureC })}</strong>
                        </div>
                        {hdd?.powerOnHours != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartPowerOnHours')}</span>
                            <strong>{formatSmartNumber(hdd.powerOnHours)}</strong>
                          </div>
                        )}
                        {hdd?.powerCycles != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartPowerCycles')}</span>
                            <strong>{formatSmartNumber(hdd.powerCycles)}</strong>
                          </div>
                        )}
                        {hdd?.startStopCount != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartStartStopCount')}</span>
                            <strong>{formatSmartNumber(hdd.startStopCount)}</strong>
                          </div>
                        )}
                        {hdd?.loadCycleCount != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartLoadCycleCount')}</span>
                            <strong>{formatSmartNumber(hdd.loadCycleCount)}</strong>
                          </div>
                        )}
                        {ssd?.percentageUsed != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartWearUsed')}</span>
                            <strong>{t('operator.smartPercentValue', { value: ssd.percentageUsed })}</strong>
                          </div>
                        )}
                        {ssd?.percentageRemaining != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartEnduranceRemaining')}</span>
                            <strong>{t('operator.smartPercentValue', { value: ssd.percentageRemaining })}</strong>
                          </div>
                        )}
                        {ssd?.availableSparePercent != null && (
                          <div className={styles.smartMetric}>
                            <span>{ssd.availableSpareThresholdPercent == null
                              ? t('operator.smartAvailableSpare')
                              : t('operator.smartAvailableSpareThreshold', { threshold: ssd.availableSpareThresholdPercent })}</span>
                            <strong>{t('operator.smartPercentValue', { value: ssd.availableSparePercent })}</strong>
                          </div>
                        )}
                        {ssd?.dataWrittenBytes != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartDataWritten')}</span>
                            <strong>{formatBytes(ssd.dataWrittenBytes)}</strong>
                          </div>
                        )}
                        {ssd?.powerOnHours != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartPowerOnHours')}</span>
                            <strong>{formatSmartNumber(ssd.powerOnHours)}</strong>
                          </div>
                        )}
                        {ssd?.powerCycles != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartPowerCycles')}</span>
                            <strong>{formatSmartNumber(ssd.powerCycles)}</strong>
                          </div>
                        )}
                        {ssd?.mediaErrors != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartMediaErrors')}</span>
                            <strong>{formatSmartNumber(ssd.mediaErrors)}</strong>
                          </div>
                        )}
                        {ssd?.unsafeShutdowns != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartUnsafeShutdowns')}</span>
                            <strong>{formatSmartNumber(ssd.unsafeShutdowns)}</strong>
                          </div>
                        )}
                        {ssd?.wearLevelingCount != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartWearLeveling')}</span>
                            <strong>{formatSmartNumber(ssd.wearLevelingCount)}</strong>
                          </div>
                        )}
                        {ssd?.reservedBlocksUsed != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartReservedBlocksUsed')}</span>
                            <strong>{formatSmartNumber(ssd.reservedBlocksUsed)}</strong>
                          </div>
                        )}
                        {ssd?.programFailures != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartProgramFailures')}</span>
                            <strong>{formatSmartNumber(ssd.programFailures)}</strong>
                          </div>
                        )}
                        {ssd?.eraseFailures != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartEraseFailures')}</span>
                            <strong>{formatSmartNumber(ssd.eraseFailures)}</strong>
                          </div>
                        )}
                        {drive.criticalWarning != null && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartCriticalWarning')}</span>
                            <strong>{formatSmartNumber(drive.criticalWarning)}</strong>
                          </div>
                        )}
                        {(drive.kind !== 'ssd' || drive.ataAttributes.reallocatedSectors != null) && (
                          <div className={styles.smartMetric}>
                            <span>{drive.kind === 'ssd' ? t('operator.smartNandReallocated') : t('operator.smartReallocated')}</span>
                            <strong>{formatSmartNumber(drive.ataAttributes.reallocatedSectors)}</strong>
                          </div>
                        )}
                        {(drive.kind !== 'ssd' || drive.ataAttributes.pendingSectors != null) && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartPending')}</span>
                            <strong>{formatSmartNumber(drive.ataAttributes.pendingSectors)}</strong>
                          </div>
                        )}
                        {(drive.kind !== 'ssd' || drive.ataAttributes.uncorrectableSectors != null) && (
                          <div className={styles.smartMetric}>
                            <span>{t('operator.smartUncorrectable')}</span>
                            <strong>{formatSmartNumber(drive.ataAttributes.uncorrectableSectors)}</strong>
                          </div>
                        )}
                      </div>

                      {drive.alertConditions?.length > 0 && (
                        <div className={styles.warningBanner}>
                          {drive.alertConditions.map((condition, index) => (
                            <div key={`${condition.severity}-${condition.message}-${index}`}>{condition.message}</div>
                          ))}
                        </div>
                      )}
                      {drive.message && <div className={styles.fieldHint}>{drive.message}</div>}
                    </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
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
            <div className={styles.dbInfoBlock}>
              <span className={styles.statusLabel}>{t('operator.dbDiskWarningEffective')}</span>
              <span className={styles.dbInlineText}>
                {diskWarningStatus
                  ? t('operator.dbDiskWarningEffectiveValue', {
                    percent: formatThresholdPercent(diskWarningStatus.effectiveSettings.usagePercentThreshold),
                    free: formatBytes(diskWarningStatus.effectiveSettings.minFreeBytesThreshold),
                  })
                  : '—'}
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
              <span className={styles.fieldLabel}>{t('operator.dbDiskWarnPercent')}</span>
              <NumericInput
                min={1}
                max={100}
                step={0.5}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', {
                  value: formatThresholdPercent(diskWarningStatus?.defaults.usagePercentThreshold ?? 0.9),
                })}
                value={diskWarningSettings.usagePercentThreshold == null ? null : Number((diskWarningSettings.usagePercentThreshold * 100).toFixed(2))}
                allowEmpty
                onChange={(value) => setDiskWarningSettings((prev) => ({
                  ...prev,
                  usagePercentThreshold: value == null ? null : value / 100,
                }))}
              />
              <span className={styles.fieldHint}>{t('operator.dbDiskWarnPercentHint')}</span>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{t('operator.dbDiskWarnFree')}</span>
              <NumericInput
                min={0}
                step={10}
                className={styles.fieldInput}
                placeholder={t('operator.placeholderDefault', {
                  value: formatGiBValue(diskWarningStatus?.defaults.minFreeBytesThreshold ?? (100 * 1024 * 1024 * 1024)),
                })}
                value={diskWarningSettings.minFreeBytesThreshold == null ? null : Number((diskWarningSettings.minFreeBytesThreshold / (1024 * 1024 * 1024)).toFixed(2))}
                allowEmpty
                onChange={(value) => setDiskWarningSettings((prev) => ({
                  ...prev,
                  minFreeBytesThreshold: value == null ? null : Math.round(value * 1024 * 1024 * 1024),
                }))}
              />
              <span className={styles.fieldHint}>{t('operator.dbDiskWarnFreeHint')}</span>
            </label>
          </div>

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
            <button className={styles.controlBtn} disabled={!!effectiveBusy} onClick={handleSaveDiskWarningSettings}>
              <HardDrive size={14} />
              {t('operator.dbSaveDiskWarning')}
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

      {/* Vector Store */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Vector Store ({vectorProvider})</span>
        </div>
        <div className={styles.sectionBody}>
          {vectorHealth && (
            <div className={styles.dbInfoGrid} style={{ marginBottom: 16 }}>
              <div className={styles.dbInfoBlock}>
                <span className={styles.statusLabel}>Provider</span>
                <span className={styles.dbInlineText}>{vectorProvider}</span>
              </div>
              <div className={styles.dbInfoBlock}>
                <span className={styles.statusLabel}>Service</span>
                <span className={styles.dbInlineText}>{vectorIsExternal ? 'External' : 'Embedded'}</span>
              </div>
              <div className={styles.dbInfoBlock}>
                <span className={styles.statusLabel}>Lexical Search</span>
                <span className={styles.dbInlineText}>{vectorSupportsLexical ? 'Native' : 'Vector-only'}</span>
              </div>
              {vectorCapabilities && (
                <div className={styles.dbInfoBlock}>
                  <span className={styles.statusLabel}>Score Mode</span>
                  <span className={styles.dbInlineText}>{vectorScoreLabel(vectorCapabilities.scoreKind)}</span>
                </div>
              )}
              {vectorConfig?.tuningProfile && (
                <div className={styles.dbInfoBlock}>
                  <span className={styles.statusLabel}>Tuning</span>
                  <span className={styles.dbInlineText}>{vectorConfig.tuningProfile.replace('_', ' ')}</span>
                </div>
              )}
            </div>
          )}

          {vectorConfig && (
            <div className={styles.dbInfoGrid} style={{ marginBottom: 16 }}>
              {vectorConfigManagedByEnv && (
                <div className={styles.warningBanner}>
                  Vector store provider and connection are managed by environment variables. Runtime tuning can still be saved here.
                </div>
              )}

              <div className={styles.tuningGrid}>
                <label className={styles.fieldGroup}>
                  <span className={styles.fieldLabel}>Provider</span>
                  <select
                    className={styles.fieldInput}
                    value={vectorDraft.provider}
                    disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                    onChange={(e) => handleVectorProviderChange(e.target.value as VectorStoreProviderId)}
                  >
                    <option value="lancedb">LanceDB (embedded)</option>
                    <option value="qdrant">Qdrant (external)</option>
                    <option value="milvus">Milvus (external)</option>
                  </select>
                  <span className={styles.fieldHint}>
                    Switching validates the connection first, then marks existing vectors for reindexing from SQLite.
                  </span>
                </label>

                <label className={styles.fieldGroup}>
                  <span className={styles.fieldLabel}>Tuning Profile</span>
                  <select
                    className={styles.fieldInput}
                    value={vectorDraft.tuningProfile}
                    disabled={!!vectorConfigBusy}
                    onChange={(e) => updateVectorDraft((prev) => ({ ...prev, tuningProfile: e.target.value as VectorStoreTuningProfile }))}
                  >
                    <option value="balanced">Balanced</option>
                    <option value="low_latency">Low latency</option>
                    <option value="low_memory">Low memory</option>
                    <option value="bulk_reindex">Bulk reindex</option>
                  </select>
                  <span className={styles.fieldHint}>{vectorTuningProfileHint(vectorDraft.tuningProfile)}</span>
                </label>

                {vectorDraft.provider === 'qdrant' && (
                  <>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Qdrant URL</span>
                      <input
                        className={styles.fieldInput}
                        placeholder="http://localhost:6333"
                        value={vectorDraft.qdrantUrl}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, qdrantUrl: e.target.value }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Collection Prefix</span>
                      <input
                        className={styles.fieldInput}
                        placeholder="lumiverse_"
                        value={vectorDraft.qdrantCollectionPrefix}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, qdrantCollectionPrefix: e.target.value }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>API Key</span>
                      <input
                        type="password"
                        className={styles.fieldInput}
                        placeholder={vectorConfig.qdrantHasApiKey ? 'Saved key will be reused' : 'Optional'}
                        value={qdrantApiKeyDraft}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => {
                          vectorDraftDirty.current = true
                          setQdrantApiKeyDraft(e.target.value)
                        }}
                      />
                    </label>
                  </>
                )}

                {vectorDraft.provider === 'milvus' && (
                  <>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Milvus Address</span>
                      <input
                        className={styles.fieldInput}
                        placeholder="localhost:19530"
                        value={vectorDraft.milvusAddress}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, milvusAddress: e.target.value }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Database</span>
                      <input
                        className={styles.fieldInput}
                        placeholder="default"
                        value={vectorDraft.milvusDatabase}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, milvusDatabase: e.target.value }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Username</span>
                      <input
                        className={styles.fieldInput}
                        placeholder="Optional"
                        value={vectorDraft.milvusUsername}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, milvusUsername: e.target.value }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Password</span>
                      <input
                        type="password"
                        className={styles.fieldInput}
                        placeholder={vectorConfig.milvusHasPassword ? 'Saved password will be reused' : 'Optional'}
                        value={milvusPasswordDraft}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => {
                          vectorDraftDirty.current = true
                          setMilvusPasswordDraft(e.target.value)
                        }}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Transport</span>
                      <select
                        className={styles.fieldInput}
                        value={vectorDraft.milvusTransport}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(e) => updateVectorDraft((prev) => ({ ...prev, milvusTransport: e.target.value as 'grpc' | 'http' }))}
                      >
                        <option value="grpc">gRPC</option>
                      </select>
                      <span className={styles.fieldHint}>Lumiverse uses the Milvus gRPC endpoint, usually port 19530.</span>
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Connect Timeout (ms)</span>
                      <NumericInput
                        className={styles.fieldInput}
                        min={1000}
                        max={60000}
                        step={500}
                        integer
                        value={vectorDraft.milvusConnectTimeoutMs}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(value) => updateVectorDraft((prev) => ({
                          ...prev,
                          milvusConnectTimeoutMs: Math.max(1000, Math.min(60000, Math.round(value ?? 5000))),
                        }))}
                      />
                      <span className={styles.fieldHint}>Used only for the initial TCP reachability probe before the SDK connects.</span>
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Request Timeout (ms)</span>
                      <NumericInput
                        className={styles.fieldInput}
                        min={0}
                        max={300000}
                        step={1000}
                        integer
                        value={vectorDraft.milvusRequestTimeoutMs}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(value) => updateVectorDraft((prev) => ({
                          ...prev,
                          milvusRequestTimeoutMs: Math.max(0, Math.min(300000, Math.round(value ?? 60000))),
                        }))}
                      />
                      <span className={styles.fieldHint}>Applied to Milvus gRPC requests, including Memory Cortex searches. Use 0 to disable the SDK deadline.</span>
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Hybrid Candidate Multiplier</span>
                      <NumericInput
                        className={styles.fieldInput}
                        min={1}
                        max={10}
                        step={1}
                        integer
                        value={vectorDraft.milvusHybridCandidateMultiplier}
                        disabled={!!vectorConfigBusy}
                        onChange={(value) => updateVectorDraft((prev) => ({
                          ...prev,
                          milvusHybridCandidateMultiplier: Math.max(1, Math.min(10, Math.round(value ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_MULTIPLIER))),
                        }))}
                      />
                      <span className={styles.fieldHint}>Per-leg over-fetch before Milvus reranks dense and BM25 hits. Final result count still comes from the feature&apos;s Top-K setting.</span>
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Hybrid Candidate Cap</span>
                      <NumericInput
                        className={styles.fieldInput}
                        min={1}
                        max={2000}
                        step={10}
                        integer
                        value={vectorDraft.milvusHybridCandidateCap}
                        disabled={!!vectorConfigBusy}
                        onChange={(value) => updateVectorDraft((prev) => ({
                          ...prev,
                          milvusHybridCandidateCap: Math.max(1, Math.min(2000, Math.round(value ?? DEFAULT_MILVUS_HYBRID_CANDIDATE_CAP))),
                        }))}
                      />
                      <span className={styles.fieldHint}>Upper bound on dense and BM25 candidates per leg before reranking. Keep this above your expected Top-K if you want actual hybrid over-fetch.</span>
                    </label>
                    <div className={styles.toggleRowCompact}>
                      <span className={styles.remoteHint}>Use TLS/SSL</span>
                      <Toggle.Switch
                        checked={vectorDraft.milvusSsl}
                        disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                        onChange={(checked) => updateVectorDraft((prev) => ({ ...prev, milvusSsl: checked }))}
                      />
                    </div>
                  </>
                )}
              </div>

              {vectorTestResult && (
                <div className={vectorTestResult.ok ? styles.disabledHint : styles.warningBanner}>
                  {vectorTestResult.ok
                    ? `${vectorProviderLabel(vectorTestResult.provider)} connection test passed.`
                    : vectorTestResult.error || 'Vector store connection test failed.'}
                </div>
              )}

              <div className={styles.controls}>
                <button
                  className={styles.controlBtn}
                  disabled={!!vectorConfigBusy}
                  onClick={() => refreshVectorConfig(true)}
                >
                  <RefreshCw size={14} />
                  Reload Config
                </button>
                <button
                  className={styles.controlBtnPrimary}
                  disabled={!vectorRuntimeTuningChanged || !!vectorConfigBusy}
                  onClick={handleVectorSaveRuntimeTuning}
                >
                  {vectorConfigBusy === 'saving'
                    ? <Loader2 size={14} className={spinClass} />
                    : <HardDrive size={14} />}
                  Apply Runtime Tuning
                </button>
                <button
                  className={styles.controlBtnPrimary}
                  disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                  onClick={handleVectorTest}
                >
                  {vectorConfigBusy === 'testing'
                    ? <Loader2 size={14} className={spinClass} />
                    : <Wifi size={14} />}
                  Test Connection
                </button>
                <button
                  className={styles.controlBtnDanger}
                  disabled={vectorConfigManagedByEnv || !!vectorConfigBusy}
                  onClick={() => setConfirm({
                    title: 'Switch Vector Store',
                    message: 'This validates the target store, switches the active vector database, clears vector caches, and marks existing content for reindexing. Existing vectors are not migrated.',
                    variant: 'warning',
                    confirmText: 'Switch Store',
                    onConfirm: async () => {
                      setConfirm(null)
                      await handleVectorSwitch()
                    },
                  })}
                >
                  {vectorConfigBusy === 'switching'
                    ? <Loader2 size={14} className={spinClass} />
                    : <GitBranch size={14} />}
                  Switch Store
                </button>
              </div>
            </div>
          )}

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
                          {vectorCapabilities?.managesOwnIndexes !== false && (
                            <>
                              <div className={styles.statusCard}>
                                <span className={styles.statusLabel}>{t('operator.vectorScalarIndexes')}</span>
                                <span className={styles.statusValue}>{tableHealth.scalarIndexReady ? t('operator.indexActive') : t('operator.indexPending')}</span>
                              </div>
                              {vectorSupportsLexical && (
                                <div className={styles.statusCard}>
                                  <span className={styles.statusLabel}>{t('operator.vectorFtsIndex')}</span>
                                  <span className={styles.statusValue}>{tableHealth.ftsIndexReady ? t('operator.indexActive') : t('operator.indexPending')}</span>
                                </div>
                              )}
                              <div className={styles.statusCard}>
                                <span className={styles.statusLabel}>{t('operator.vectorUnindexedRows')}</span>
                                <span className={styles.statusValue}>{tableHealth.unindexedRowEstimate.toLocaleString()}</span>
                              </div>
                            </>
                          )}
                          {tableHealth.dimension != null && (
                            <div className={styles.statusCard}>
                              <span className={styles.statusLabel}>Dimension</span>
                              <span className={styles.statusValue}>{tableHealth.dimension}</span>
                            </div>
                          )}
                          {tableHealth.indexes.length > 0 && (
                            <div className={styles.statusCard}>
                              <span className={styles.statusLabel}>{t('operator.vectorIndexes')}</span>
                              <span className={styles.statusValue}>{tableHealth.indexes.length}</span>
                            </div>
                          )}
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
              disabled={!!vectorBusy || !vectorHealth?.exists || !vectorSupportsOptimize}
              onClick={handleVectorOptimize}
              title={vectorSupportsOptimize ? undefined : `${vectorProvider} handles optimization server-side`}
            >
              {vectorBusy === 'compacting'
                ? <Loader2 size={14} className={spinClass} />
                : <Hammer size={14} />}
              {vectorSupportsOptimize ? t('operator.compactRebuildIndex') : 'Server-managed Optimization'}
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
              {vectorIsExternal ? 'Drop Collections' : t('operator.forceReset')}
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
