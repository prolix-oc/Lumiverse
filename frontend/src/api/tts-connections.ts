import { get, post, put, del, upload } from './client'
import type {
  TtsConnectionProfile,
  CreateTtsConnectionInput,
  UpdateTtsConnectionInput,
  TtsConnectionTestResult,
  TtsConnectionModelsResult,
  TtsConnectionVoicesResult,
  TtsConnectionModelsPreviewInput,
  TtsConnectionVoicesPreviewInput,
  TtsProviderInfo,
  PaginatedResult,
  QwenCustomVoiceCreateResult,
  QwenCustomVoiceDeleteResult,
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

  previewModels(input: TtsConnectionModelsPreviewInput) {
    return post<TtsConnectionModelsResult>('/tts-connections/models/preview', input)
  },

  voices(id: string) {
    return get<TtsConnectionVoicesResult>(`/tts-connections/${id}/voices`)
  },

  previewVoices(input: TtsConnectionVoicesPreviewInput) {
    return post<TtsConnectionVoicesResult>('/tts-connections/voices/preview', input)
  },

  setApiKey(id: string, apiKey: string) {
    return put<{ success: boolean }>(`/tts-connections/${id}/api-key`, { api_key: apiKey })
  },

  clearApiKey(id: string) {
    return del<{ success: boolean }>(`/tts-connections/${id}/api-key`)
  },

  createQwenCustomVoice(
    id: string,
    input: {
      name: string
      transcript?: string
      audio: File
      xVectorOnlyMode?: boolean
    },
  ) {
    const formData = new FormData()
    formData.append('name', input.name)
    if (input.transcript) formData.append('transcript', input.transcript)
    formData.append('audio', input.audio)
    if (input.xVectorOnlyMode) formData.append('x_vector_only_mode', 'true')
    return upload<QwenCustomVoiceCreateResult>(`/tts-connections/${id}/qwen/custom-voices`, formData, { timeout: 120_000 })
  },

  deleteQwenCustomVoice(id: string, voiceId: string) {
    return del<QwenCustomVoiceDeleteResult>(`/tts-connections/${id}/qwen/custom-voices/${encodeURIComponent(voiceId)}`)
  },

  providers() {
    return get<{ providers: TtsProviderInfo[] }>('/tts-connections/providers')
  },
}
