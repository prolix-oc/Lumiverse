import { get, post, put, del } from './client'
import type { OperatorLogEntry, OperatorStatusPayload } from '@/types/ws-events'

export type OperatorStatus = OperatorStatusPayload

export interface OperatorLogsResponse {
  entries: OperatorLogEntry[]
}

export interface UpdateCheckResult {
  available: boolean
  commitsBehind: number
  latestMessage: string
}

export interface OperationResult {
  message: string
}

export interface RemoteToggleResult {
  enabled: boolean
  message: string
}

export interface DatabaseTuningSettings {
  cacheMemoryPercent?: number | null
  mmapSizeBytes?: number | null
}

export interface SharpSettings {
  concurrency?: number | null
  cacheMemoryMb?: number | null
  cacheFiles?: number | null
  cacheItems?: number | null
}

export interface ResolvedSharpSettings {
  concurrency: number
  cacheMemoryMb: number
  cacheFiles: number
  cacheItems: number
}

export interface OperatorSharpStatus {
  settingsKey: string
  configuredSettings: SharpSettings
  effectiveSettings: ResolvedSharpSettings
  defaults: ResolvedSharpSettings
}

export interface DnsSettings {
  dohFallbackEnabled?: boolean
  dohEndpoint?: string
}

export interface DiskWarningSettings {
  /** 0..1 ratio; 0.9 = 90% used */
  usagePercentThreshold?: number | null
  minFreeBytesThreshold?: number | null
}

export interface ResolvedDiskWarningSettings {
  usagePercentThreshold: number
  minFreeBytesThreshold: number
}

export interface OperatorDiskWarningStatus {
  settingsKey: string
  configuredSettings: DiskWarningSettings
  effectiveSettings: ResolvedDiskWarningSettings
  defaults: ResolvedDiskWarningSettings
}

export type SmartctlAvailability = 'available' | 'installable' | 'manual' | 'unsupported'
export type SmartDriveStatus = 'ok' | 'warning' | 'failing' | 'unavailable' | 'standby'
export type SmartDriveKind = 'ssd' | 'hdd' | 'unknown'
export type SmartAlertSeverity = 'warning' | 'failing'

export interface SmartctlBinary {
  path: string
  version: string | null
}

export interface SmartctlInstallPlan {
  manager: 'apt-get' | 'dnf' | 'yum' | 'apk' | 'pacman' | 'zypper' | 'brew' | 'choco'
  command: string[]
  requiresElevation: boolean
}

export interface SmartDriveSummary {
  device: string
  protocol: string | null
  kind: SmartDriveKind
  model: string | null
  serialNumber: string | null
  status: SmartDriveStatus
  temperatureC: number | null
  exitStatus: number
  percentageUsed: number | null
  criticalWarning: number | null
  ataAttributes: {
    reallocatedSectors: number | null
    pendingSectors: number | null
    uncorrectableSectors: number | null
  }
  alertConditions: Array<{
    severity: SmartAlertSeverity
    message: string
  }>
  ssd: {
    percentageUsed: number | null
    percentageRemaining: number | null
    availableSparePercent: number | null
    availableSpareThresholdPercent: number | null
    dataWrittenBytes: number | null
    powerOnHours: number | null
    powerCycles: number | null
    unsafeShutdowns: number | null
    mediaErrors: number | null
    wearLevelingCount: number | null
    reservedBlocksUsed: number | null
    programFailures: number | null
    eraseFailures: number | null
  } | null
  hdd: {
    powerOnHours: number | null
    powerCycles: number | null
    startStopCount: number | null
    loadCycleCount: number | null
  } | null
  message: string | null
}

export interface SmartctlSnapshot {
  checkedAt: string
  drives: SmartDriveSummary[]
  error: string | null
}

export interface OperatorSmartctlStatus {
  availability: SmartctlAvailability
  binary: SmartctlBinary | null
  installPlan: SmartctlInstallPlan | null
  message: string
  latestSnapshot: SmartctlSnapshot | null
  snapshot: SmartctlSnapshot
}

export interface SmartctlInstallResult {
  installed: boolean
  status: Omit<OperatorSmartctlStatus, 'snapshot'>
  error: string | null
}

export interface ResolvedDnsSettings {
  dohFallbackEnabled: boolean
  dohEndpoint: string
}

export interface OperatorDnsStatus {
  settingsKey: string
  configuredSettings: DnsSettings
  effectiveSettings: ResolvedDnsSettings
  defaults: ResolvedDnsSettings
}

export interface DatabaseMaintenanceSettings {
  optimizeIntervalHours?: number | null
  analyzeIntervalHours?: number | null
  autoVacuumEnabled?: boolean
  vacuumIntervalHours?: number | null
  vacuumMinIdleMinutes?: number
  vacuumRequireNoVisibleClients?: boolean
  vacuumRequireNoActiveGenerations?: boolean
  vacuumMinReclaimBytes?: number
  vacuumMinReclaimPercent?: number
  vacuumMinDbSizeBytes?: number
  vacuumCheckpointMode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'
}

export interface DatabaseMaintenanceState {
  lastOptimizeAt?: number | null
  lastAnalyzeAt?: number | null
  lastVacuumAt?: number | null
  lastAutoVacuumAttemptAt?: number | null
  lastAutoVacuumSuccessAt?: number | null
  lastAutoVacuumSkipReason?: string | null
}

export interface DatabaseStats {
  path: string
  hostMemoryBytes: number
  fileBytes: number
  walBytes: number
  shmBytes: number
  totalOnDiskBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
  usedPageCount: number
  logicalBytes: number
  usedBytes: number
  freeBytes: number
  journalMode: string
  synchronous: string
  tempStore: string
  mmapSize: number
  cacheSize: number
  cacheBytesApprox: number
  walAutocheckpoint: number
  journalSizeLimit: number
  filesystemTotalBytes: number | null
  filesystemFreeBytes: number | null
  vacuumEstimatedRequiredBytes: number
  vacuumHasEnoughFreeBytes: boolean | null
}

export interface AppliedDatabaseTuning {
  settingsKey: string
  settings: DatabaseTuningSettings
  cacheMemoryPercent: number | null
  cacheBytes: number
  cacheSource: 'auto' | 'settings'
  mmapSizeBytes: number
  mmapSource: 'auto' | 'settings' | 'disabled'
  journalSizeLimitBytes: number
}

export interface OperatorDatabaseStatus {
  settingsKey: string
  maintenanceSettingsKey: string
  maintenanceStateKey: string
  configuredSettings: DatabaseTuningSettings
  maintenanceSettings: DatabaseMaintenanceSettings
  maintenanceState: DatabaseMaintenanceState
  effectiveTuning: AppliedDatabaseTuning
  stats: DatabaseStats
  recommendation: {
    cacheMemoryPercent: number | null
    cacheBytes: number
    mmapSizeBytes: number
  }
  automaticMaintenance: {
    settings: DatabaseMaintenanceSettings
    state: DatabaseMaintenanceState
    visibility: {
      totalSessions: number
      visibleSessions: number
      hiddenSessions: number
      isVisible: boolean
      allHiddenSince: number | null
      hiddenIdleMinutes: number | null
    }
    activeGenerationCount: number
    operatorBusy: string | null
    lastWriteAt: number | null
    lastWriteIdleMinutes: number | null
    reclaimableBytes: number
    reclaimablePercent: number
    optimize: { dueAt: number | null; isDue: boolean }
    analyze: { dueAt: number | null; isDue: boolean }
    vacuum: { dueAt: number | null; isDue: boolean; eligible: boolean; blockedReasons: string[] }
  }
}

export interface DatabaseMaintenanceResult {
  statsBefore: DatabaseStats
  statsAfter: DatabaseStats
  tuning: AppliedDatabaseTuning | null
  checkpoint: Record<string, number> | null
  optimized: boolean
  analyzed: boolean
  vacuumed: boolean
  state: DatabaseMaintenanceState | null
}

export type TrustedHostSource = 'hostname' | 'mdns' | 'reverse-dns' | 'tailscale' | 'lan-ip' | 'env' | 'configured'

export interface TrustedHostEntry {
  host: string
  source: TrustedHostSource
}

export interface TrustedHostsResponse {
  configured: string[]
  baseline: TrustedHostEntry[]
  hostname: string
  suggestions: TrustedHostEntry[]
}

export interface TrustedHostsUpdateResponse {
  configured: string[]
  baseline: TrustedHostEntry[]
}

export const operatorApi = {
  getStatus: () => get<OperatorStatus>('/operator/status'),
  getTrustedHosts: (fresh = false) => get<TrustedHostsResponse>('/operator/trusted-hosts', fresh ? { fresh: 1 } : undefined),
  putTrustedHosts: (hosts: string[]) => put<TrustedHostsUpdateResponse>('/operator/trusted-hosts', { hosts }),
  getDatabase: () => get<OperatorDatabaseStatus>('/operator/database'),
  getSharp: () => get<OperatorSharpStatus>('/operator/sharp'),
  putSharp: (settings: SharpSettings) => put<OperatorSharpStatus>('/operator/sharp', settings),
  getDns: () => get<OperatorDnsStatus>('/operator/dns'),
  putDns: (settings: DnsSettings) => put<OperatorDnsStatus>('/operator/dns', settings),
  getDiskWarning: () => get<OperatorDiskWarningStatus>('/operator/disk-warning'),
  putDiskWarning: (settings: DiskWarningSettings) => put<OperatorDiskWarningStatus>('/operator/disk-warning', settings),
  getSmartctl: (refresh = false) => get<OperatorSmartctlStatus>('/operator/smartctl', refresh ? { refresh: 1 } : undefined),
  installSmartctl: () => post<SmartctlInstallResult>('/operator/smartctl/install'),
  getLogs: (limit = 150) => get<OperatorLogsResponse>('/operator/logs', { limit }),
  subscribeLogs: () => post<{ subscribed: boolean }>('/operator/logs/subscribe'),
  unsubscribeLogs: () => del<{ subscribed: boolean }>('/operator/logs/subscribe'),
  maintainDatabase: (body?: { optimize?: boolean; analyze?: boolean; vacuum?: boolean; refreshTuning?: boolean; checkpointMode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' }) =>
    post<DatabaseMaintenanceResult>('/operator/database/maintenance', body ?? {}),
  checkUpdate: () => post<UpdateCheckResult>('/operator/update/check'),
  applyUpdate: () => post<OperationResult>('/operator/update/apply'),
  switchBranch: (target: string) => post<OperationResult>('/operator/branch', { target }),
  toggleRemote: (enable: boolean) => post<RemoteToggleResult>('/operator/remote', { enable }),
  restart: () => post<OperationResult>('/operator/restart'),
  shutdown: () => post<OperationResult>('/operator/shutdown'),
  clearCache: () => post<OperationResult>('/operator/cache/clear'),
  rebuildFrontend: () => post<OperationResult>('/operator/rebuild'),
  ensureDependencies: () => post<OperationResult>('/operator/deps'),
}
