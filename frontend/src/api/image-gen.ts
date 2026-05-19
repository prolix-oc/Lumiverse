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
  scene?: SceneData
  prompt: string
  negativePrompt?: string
  provider: string
  imageDataUrl?: string
  imageId?: string
  imageUrl?: string
  message?: import('@/types/api').Message
}

export type ImageGenPromptMode = 'scene' | 'custom' | 'parsed_custom'
export type ImageGenOutputTarget = 'background' | 'chat_attachment' | 'preview'

const CLIENT_TIMEOUT_BUFFER_MS = 10_000

function resolveClientTimeoutMs(promptTimeoutSeconds?: number, generationTimeoutSeconds?: number): number {
  const promptTimeout = Number.isFinite(promptTimeoutSeconds) ? Math.max(0, Math.floor(promptTimeoutSeconds!)) : 60
  const generationTimeout = Number.isFinite(generationTimeoutSeconds) ? Math.max(0, Math.floor(generationTimeoutSeconds!)) : 300
  if (promptTimeout === 0 || generationTimeout === 0) return 0
  return (promptTimeout + generationTimeout) * 1000 + CLIENT_TIMEOUT_BUFFER_MS
}

export const imageGenApi = {
  generate(input: {
    chatId: string
    forceGeneration?: boolean
    promptMode?: ImageGenPromptMode
    prompt?: string
    negativePrompt?: string
    promptPresetId?: string | null
    outputTarget?: ImageGenOutputTarget
    promptGenerationTimeoutSeconds?: number
    generationTimeoutSeconds?: number
  }) {
    return post<ImageGenResponse>('/image-gen/generate', input, {
      timeout: resolveClientTimeoutMs(input.promptGenerationTimeoutSeconds, input.generationTimeoutSeconds),
    })
  },
}
