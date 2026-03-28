import { get, post, del } from './client'
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

export const operatorApi = {
  getStatus: () => get<OperatorStatus>('/operator/status'),
  getLogs: (limit = 150) => get<OperatorLogsResponse>('/operator/logs', { limit }),
  subscribeLogs: () => post<{ subscribed: boolean }>('/operator/logs/subscribe'),
  unsubscribeLogs: () => del<{ subscribed: boolean }>('/operator/logs/subscribe'),
  checkUpdate: () => post<UpdateCheckResult>('/operator/update/check'),
  applyUpdate: () => post<OperationResult>('/operator/update/apply'),
  switchBranch: (target: string) => post<OperationResult>('/operator/branch', { target }),
  toggleRemote: (enable: boolean) => post<RemoteToggleResult>('/operator/remote', { enable }),
  restart: () => post<OperationResult>('/operator/restart'),
  shutdown: () => post<OperationResult>('/operator/shutdown'),
}
