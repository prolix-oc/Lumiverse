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
