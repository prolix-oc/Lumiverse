import type { StateCreator } from 'zustand'
import type { GenerationSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'

export const createGenerationSlice: StateCreator<GenerationSlice> = (set) => ({
  imageGeneration: {
    enabled: false,
    provider: 'google_gemini',
    includeCharacters: false,
    google: {
      model: 'gemini-3.1-flash-image',
      aspectRatio: '16:9',
      imageSize: '1K',
      connectionProfileId: null,
      referenceImages: [],
    },
    nanogpt: {
      model: 'hidream',
      size: '1024x1024',
      apiKey: '',
      referenceImages: [],
      strength: 0.8,
      guidanceScale: 7.5,
      numInferenceSteps: 30,
      seed: null,
    },
    novelai: {
      apiKey: '',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler_ancestral',
      resolution: '1216x832',
      steps: 28,
      guidance: 5,
      negativePrompt: 'lowres, bad anatomy, blurry, text, watermark, error, worst quality',
      smea: false,
      smeaDyn: false,
      seed: null,
      referenceImages: [],
      includeCharacterAvatar: false,
      includePersonaAvatar: false,
      referenceStrength: 0.5,
      referenceInfoExtracted: 1,
      referenceFidelity: 1,
      referenceType: 'character&style',
      avatarReferenceType: 'character',
    },
    sceneChangeThreshold: 2,
    autoGenerate: true,
    forceGeneration: false,
    backgroundOpacity: 0.35,
    fadeTransitionMs: 800,
  },
  sceneBackground: null,
  sceneGenerating: false,

  setImageGenSettings: (settings) =>
    set((state) => {
      const imageGeneration = { ...state.imageGeneration, ...settings }
      settingsApi.put('imageGeneration', imageGeneration).catch(() => {})
      return { imageGeneration }
    }),
  setSceneBackground: (url) => set({ sceneBackground: url }),
  setSceneGenerating: (generating) => set({ sceneGenerating: generating }),
})
