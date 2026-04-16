import { get, post, put, del } from './client'
import type {
  TtsConnectionProfile,
  CreateTtsConnectionInput,
  UpdateTtsConnectionInput,
  TtsConnectionTestResult,
  TtsConnectionModelsResult,
  TtsConnectionVoicesResult,
  TtsProviderInfo,
  PaginatedResult,
} from '@/types/api'

export const ttsConnectionsApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<TtsConnectionProfile>>('/tts-connections', params)
  },

  get(id: string) {
    return get<TtsConnectionProfile>(`/tts-connections/${id}`)
  },

  create(input: CreateTtsConnectionInput) {
    return post<TtsConnectionProfile>('/tts-connections', input)
  },

  update(id: string, input: UpdateTtsConnectionInput) {
    return put<TtsConnectionProfile>(`/tts-connections/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/tts-connections/${id}`)
  },

  duplicate(id: string) {
    return post<TtsConnectionProfile>(`/tts-connections/${id}/duplicate`)
  },

  test(id: string) {
    return post<TtsConnectionTestResult>(`/tts-connections/${id}/test`)
  },

  models(id: string) {
    return get<TtsConnectionModelsResult>(`/tts-connections/${id}/models`)
  },

  voices(id: string) {
    return get<TtsConnectionVoicesResult>(`/tts-connections/${id}/voices`)
  },

  setApiKey(id: string, apiKey: string) {
    return put<{ success: boolean }>(`/tts-connections/${id}/api-key`, { api_key: apiKey })
  },

  clearApiKey(id: string) {
    return del<{ success: boolean }>(`/tts-connections/${id}/api-key`)
  },

  providers() {
    return get<{ providers: TtsProviderInfo[] }>('/tts-connections/providers')
  },
}
