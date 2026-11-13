import { get, put, del, type RequestOptions } from './client'

export interface RequestHistorySummary {
  id: string
  sentAt: number
  origin: { kind: 'chat' | 'sidecar' | 'extension' | 'api'; name: string; operation?: string; extensionId?: string }
  provider: string
  model: string
  chatId?: string
  generationId?: string
  connectionId?: string
  bodyBytes: number
  redacted: boolean
  bodyUnavailable?: 'too_large' | 'unavailable'
  response: {
    state: 'pending' | 'receiving' | 'complete' | 'interrupted' | 'cancelled' | 'failed'
    status?: number
    completedAt?: number
    bodyBytes: number
    format?: 'json' | 'text'
    redacted: boolean
    partial?: boolean
    bodyUnavailable?: 'too_large' | 'unavailable'
  }
}

export interface RequestHistoryEntry extends RequestHistorySummary {
  bodyJson: string | null
  responseBody: string | null
  responseError: string | null
}

export interface RequestHistoryState {
  enabled: boolean
  limit: number
  entries: RequestHistorySummary[]
}

export const requestHistoryApi = {
  list: (options?: RequestOptions) => get<RequestHistoryState>('/request-history', undefined, options),
  get: (id: string, options?: RequestOptions) => get<RequestHistoryEntry>(`/request-history/${encodeURIComponent(id)}`, undefined, options),
  setTracking: (enabled: boolean) => put<RequestHistoryState>('/request-history/tracking', { enabled }),
  clear: () => del<RequestHistoryState>('/request-history'),
}
