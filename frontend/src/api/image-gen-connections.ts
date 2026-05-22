import { get, post, put, del } from './client'
import type { ComfyUICapabilities } from './image-gen'
import type { ComfyUIFieldMapping, ComfyUIWorkflowConfig } from './dream-weaver'
import type {
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
  UpdateImageGenConnectionInput,
  PaginatedResult,
  ImageGenConnectionTestResult,
  ImageGenConnectionModelsResult,
  ImageGenConnectionModelsPreviewInput,
  ImageGenProviderInfo,
  NanoGptSubscriptionUsage,
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

  nanogptUsage(id: string) {
    return get<NanoGptSubscriptionUsage>(`/image-gen-connections/${id}/nanogpt-usage`)
  },

  previewModels(input: ImageGenConnectionModelsPreviewInput) {
    return post<ImageGenConnectionModelsResult>('/image-gen-connections/models/preview', input)
  },

  modelsBySubtype(id: string, subtype: string) {
    return get<ImageGenConnectionModelsResult>(`/image-gen-connections/${id}/models/${encodeURIComponent(subtype)}`)
  },

  importComfyUIWorkflow(id: string, workflow: unknown) {
    return post<{ config: ComfyUIWorkflowConfig }>(`/image-gen-connections/${id}/comfyui/workflow/import`, { workflow })
  },

  getComfyUIWorkflowConfig(id: string) {
    return get<{ config: ComfyUIWorkflowConfig | null }>(`/image-gen-connections/${id}/comfyui/workflow`)
  },

  updateComfyUIWorkflowMappings(id: string, mappings: ComfyUIFieldMapping[]) {
    return put<{ config: ComfyUIWorkflowConfig }>(`/image-gen-connections/${id}/comfyui/workflow/mappings`, { mappings })
  },

  async getComfyUICapabilities(id: string, forceRefresh = false) {
    const query = forceRefresh ? '?refresh=1' : ''
    const response = await get<{ capabilities: ComfyUICapabilities }>(`/image-gen-connections/${id}/comfyui/capabilities${query}`)
    return response.capabilities
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
