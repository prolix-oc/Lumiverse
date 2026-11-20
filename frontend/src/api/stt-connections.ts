import { get, post, put, del } from './client'
import type {
  SttConnectionProfile,
  CreateSttConnectionInput,
  UpdateSttConnectionInput,
  SttConnectionTestResult,
  SttConnectionModelsResult,
  SttProviderInfo,
  PaginatedResult,
} from '@/types/api'

export const sttConnectionsApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<SttConnectionProfile>>('/stt-connections', params)
  },

  get(id: string) {
    return get<SttConnectionProfile>(`/stt-connections/${id}`)
  },

  create(input: CreateSttConnectionInput) {
    return post<SttConnectionProfile>('/stt-connections', input)
  },

  update(id: string, input: UpdateSttConnectionInput) {
    return put<SttConnectionProfile>(`/stt-connections/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/stt-connections/${id}`)
  },

  duplicate(id: string) {
    return post<SttConnectionProfile>(`/stt-connections/${id}/duplicate`)
  },

  test(id: string) {
    return post<SttConnectionTestResult>(`/stt-connections/${id}/test`)
  },

  models(id: string) {
    return get<SttConnectionModelsResult>(`/stt-connections/${id}/models`)
  },

  previewModels(input: { connection_id?: string; provider: string; api_url?: string; api_key?: string }) {
    return post<SttConnectionModelsResult>('/stt-connections/models/preview', input)
  },

  setApiKey(id: string, apiKey: string) {
    return put<{ success: boolean }>(`/stt-connections/${id}/api-key`, { api_key: apiKey })
  },

  clearApiKey(id: string) {
    return del<{ success: boolean }>(`/stt-connections/${id}/api-key`)
  },

  providers() {
    return get<{ providers: SttProviderInfo[] }>('/stt-connections/providers')
  },
}
