import { get, post } from './client'

export interface ComfyUICapabilities {
  checkpoints: string[]
  unets: string[]
  clips: string[]
  dualClips: string[]
  vaes: string[]
  loras: string[]
  upscaleModels: string[]
  detectorModels: string[]
  samplers: string[]
  schedulers: string[]
  installedPacks: {
    impactPack: boolean
    upscaling: boolean
    controlnet: boolean
  }
  modelLoaderType: 'checkpoint' | 'unet' | 'both'
  clipLoaderType: 'single' | 'dual' | 'none'
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
  imageId?: string
  imageUrl?: string
}

export const imageGenApi = {
  generate(input: { chatId: string; forceGeneration?: boolean }) {
    return post<ImageGenResponse>('/image-gen/generate', input)
  },
}
