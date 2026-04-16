import { get, post, put, del } from './client'
import type {
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
  UpdateImageGenConnectionInput,
  PaginatedResult,
  ImageGenConnectionTestResult,
  ImageGenConnectionModelsResult,
  ImageGenProviderInfo,
  PollinationsAuthUrlRequest,
  PollinationsAuthUrlResponse,
} from '@/types/api'

export const imageGenConnectionsApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<ImageGenConnectionProfile>>('/image-gen-connections', params)
  },

  get(id: string) {
    return get<ImageGenConnectionProfile>(`/image-gen-connections/${id}`)
  },

  create(input: CreateImageGenConnectionInput) {
    return post<ImageGenConnectionProfile>('/image-gen-connections', input)
  },

  update(id: string, input: UpdateImageGenConnectionInput) {
    return put<ImageGenConnectionProfile>(`/image-gen-connections/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/image-gen-connections/${id}`)
  },

  duplicate(id: string) {
    return post<ImageGenConnectionProfile>(`/image-gen-connections/${id}/duplicate`)
  },

  test(id: string) {
    return post<ImageGenConnectionTestResult>(`/image-gen-connections/${id}/test`)
  },

  models(id: string) {
    return get<ImageGenConnectionModelsResult>(`/image-gen-connections/${id}/models`)
  },

  modelsBySubtype(id: string, subtype: string) {
    return get<ImageGenConnectionModelsResult>(`/image-gen-connections/${id}/models/${encodeURIComponent(subtype)}`)
  },

  setApiKey(id: string, apiKey: string) {
    return put<{ success: boolean }>(`/image-gen-connections/${id}/api-key`, { api_key: apiKey })
  },

  clearApiKey(id: string) {
    return del<{ success: boolean }>(`/image-gen-connections/${id}/api-key`)
  },

  pollinationsAuthUrl(input: PollinationsAuthUrlRequest) {
    return post<PollinationsAuthUrlResponse>('/connections/pollinations/auth-url', input)
  },

  providers() {
    return get<{ providers: ImageGenProviderInfo[] }>('/image-gen-connections/providers')
  },
}
