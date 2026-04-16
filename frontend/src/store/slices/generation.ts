import type { StateCreator } from 'zustand'
import type { GenerationSlice } from '@/types/store'
import { persistKey } from './settings'

export const createGenerationSlice: StateCreator<GenerationSlice> = (set) => ({
  imageGeneration: {
    enabled: false,
    activeImageGenConnectionId: null,
    includeCharacters: false,
    parameters: {},
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
      persistKey('imageGeneration', imageGeneration)
      return { imageGeneration }
    }),
  setSceneBackground: (url) => set({ sceneBackground: url }),
  setSceneGenerating: (generating) => set({ sceneGenerating: generating }),
})
