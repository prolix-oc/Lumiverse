import { get, post, put, del } from './client'

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
  character_names?: string
  character_appearances?: Array<{
    name?: string
    role?: string
    appearance?: string
    tags?: string
  }>
  composition_subjects?: string
  composition_shot?: string
  composition_camera?: string
  composition_rating?: string[]
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
  jobId?: string
}

export interface ImageGenPromptPreviewResponse {
  prompt: string
  negativePrompt?: string
  scene?: SceneData
  provider: string
}

export interface ImageGenPresetBinding {
  preset_id: string
  bound_at: number
}

export type ImageGenPromptMode = 'scene' | 'custom' | 'parsed_custom'
export type ImageGenOutputTarget = 'background' | 'chat_attachment' | 'preview' | 'attach_to_message'

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
    attachToMessageId?: string
    skipParse?: boolean
    clientJobId?: string
    promptGenerationTimeoutSeconds?: number
    generationTimeoutSeconds?: number
  }) {
    return post<ImageGenResponse>('/image-gen/generate', input, {
      timeout: resolveClientTimeoutMs(input.promptGenerationTimeoutSeconds, input.generationTimeoutSeconds),
    })
  },

  previewPrompt(input: {
    chatId: string
    promptMode?: ImageGenPromptMode
    prompt?: string
    negativePrompt?: string
    promptPresetId?: string | null
    promptGenerationTimeoutSeconds?: number
  }) {
    return post<ImageGenPromptPreviewResponse>('/image-gen/preview-prompt', input, {
      timeout: resolveClientTimeoutMs(input.promptGenerationTimeoutSeconds, 0),
    })
  },
}

export const imageGenPresetBindingsApi = {
  getCharacterBinding(characterId: string) {
    return get<ImageGenPresetBinding>(`/image-gen/preset-bindings/character/${characterId}`)
  },
  setCharacterBinding(characterId: string, presetId: string) {
    return put<ImageGenPresetBinding>(`/image-gen/preset-bindings/character/${characterId}`, {
      preset_id: presetId,
    })
  },
  deleteCharacterBinding(characterId: string) {
    return del<void>(`/image-gen/preset-bindings/character/${characterId}`)
  },
  getPersonaBinding(personaId: string) {
    return get<ImageGenPresetBinding>(`/image-gen/preset-bindings/persona/${personaId}`)
  },
  setPersonaBinding(personaId: string, presetId: string) {
    return put<ImageGenPresetBinding>(`/image-gen/preset-bindings/persona/${personaId}`, {
      preset_id: presetId,
    })
  },
  deletePersonaBinding(personaId: string) {
    return del<void>(`/image-gen/preset-bindings/persona/${personaId}`)
  },
}
