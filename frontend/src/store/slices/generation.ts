import type { StateCreator } from 'zustand'
import type { AppStore, GenerationSlice } from '@/types/store'
import { persistKey, persistPendingImageGenerationPatch } from './settings'

export const createGenerationSlice: StateCreator<AppStore, [], [], GenerationSlice> = (set) => ({
  imageGeneration: {
    enabled: false,
    activeImageGenConnectionId: null,
    includeCharacters: false,
    promptMode: 'scene',
    customPrompt: '',
    customNegativePrompt: '',
    activePromptPresetId: null,
    promptPresets: [],
    promptParserConnectionId: null,
    promptParserModel: '',
    promptParserParameters: {},
    outputTarget: 'background',
    parameters: {},
    promptGenerationTimeoutSeconds: 60,
    generationTimeoutSeconds: 300,
    promptContextMessageLimit: 3,
    sceneChangeThreshold: 2,
    autoGenerate: true,
    forceGeneration: false,
    recycleGeneratedImages: false,
    recycledImageLimit: 1,
    backgroundOpacity: 0.35,
    fadeTransitionMs: 800,
  },
  pendingImageGenerationPatch: undefined,
  sceneBackground: null,
  sceneGenerating: false,

  setImageGenSettings: (settings) =>
    set((state) => {
      const imageGeneration = { ...state.imageGeneration, ...settings }
      const patch: Partial<AppStore> = { imageGeneration }
      if (state.fullSettingsLoaded) {
        persistKey('imageGeneration', imageGeneration)
        patch.pendingImageGenerationPatch = undefined
      } else {
        patch.pendingImageGenerationPatch = {
          ...state.pendingImageGenerationPatch,
          ...settings,
        }
        persistPendingImageGenerationPatch(settings)
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'activeImageGenConnectionId')) {
        patch.activeImageGenConnectionId = settings.activeImageGenConnectionId ?? null
      }
      return patch
    }),
  setSceneBackground: (url) => set({ sceneBackground: url }),
  setSceneGenerating: (generating) => set({ sceneGenerating: generating }),
})
