import { get, put } from './client'

export type InferenceRequestClass = 'interactive' | 'user' | 'retrieval' | 'background' | 'bulk'

export interface InferenceResourceGroup {
  id: string
  name: string
  origins: string[]
}

export interface InferenceSchedulerConfig {
  enabled: boolean
  unifiedLocalPool: boolean
  schedulePrivateNetwork: boolean
  extraOrigins: string[]
  excludedOrigins: string[]
  groups: InferenceResourceGroup[]
  concurrency: number
  preemptBackground: boolean
  agingMs: number
  maxWaitMs: number
}

export interface InferenceActiveLease {
  id: string
  userId: string
  requestClass: InferenceRequestClass
  purpose: string
  origin: string | null
  startedAt: number
  durationMs: number
}

export interface InferenceWaitingRequest {
  id: string
  userId: string
  requestClass: InferenceRequestClass
  purpose: string
  origin: string | null
  enqueuedAt: number
  waitMs: number
  effectivePriority: number
}

export interface InferenceResourceStats {
  granted: number
  completed: number
  preempted: number
  timedOut: number
  aborted: number
  lastWaitMs: number | null
}

export interface InferenceResource {
  key: string
  label: string
  local: boolean
  concurrency: number
  active: InferenceActiveLease[]
  waiting: InferenceWaitingRequest[]
  stats: InferenceResourceStats
  updatedAt: number
}

export interface InferenceSchedulerStatus {
  enabled: boolean
  host: boolean
  resources: InferenceResource[]
  updatedAt: number
}

export type LocalInferenceEndpointSource =
  | 'chat'
  | 'embeddings'
  | 'image-generation'
  | 'memory-cortex'
  | 'manual'

export interface LocalInferenceEndpoint {
  origin: string
  label: string
  sources: LocalInferenceEndpointSource[]
  scheduled: boolean
  excluded: boolean
}

export interface InferenceSchedulerOverview {
  config: InferenceSchedulerConfig
  status: InferenceSchedulerStatus
  endpoints: LocalInferenceEndpoint[]
}

const BASE = '/inference-scheduler'

export const inferenceSchedulerApi = {
  getOverview() {
    return get<InferenceSchedulerOverview>(BASE)
  },
  getStatus() {
    return get<{ config: InferenceSchedulerConfig; status: InferenceSchedulerStatus }>(`${BASE}/status`)
  },
  updateConfig(patch: Partial<InferenceSchedulerConfig>) {
    return put<InferenceSchedulerOverview>(`${BASE}/config`, patch)
  },
}
