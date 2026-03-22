import { get, post } from './client'

export interface ImageGenProvider {
  id: string
  name: string
  models?: Array<{ id: string; label: string }>
  aspectRatios?: string[]
  resolutions?: Array<string | { id: string; label: string }>
  samplers?: Array<{ id: string; label: string }>
  sizes?: string[]
}

export interface ImageGenProvidersResponse {
  providers: ImageGenProvider[]
}

export interface SceneData {
  environment: string
  time_of_day: string
  weather: string
  mood: string
  focal_detail: string
  palette_override?: string
  scene_changed: boolean
}

export interface ImageGenResponse {
  generated: boolean
  reason?: string
  scene: SceneData
  prompt: string
  provider: string
  imageDataUrl?: string
}

export const imageGenApi = {
  providers() {
    return get<ImageGenProvidersResponse>('/image-gen/providers')
  },

  generate(input: { chatId: string; forceGeneration?: boolean }) {
    return post<ImageGenResponse>('/image-gen/generate', input)
  },

  fetchNanoGptModels(apiKey: string) {
    return post<{ models: Array<{ id: string; label: string }> }>('/image-gen/nanogpt/models', { apiKey })
  },
}
