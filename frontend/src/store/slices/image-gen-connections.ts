import type { StateCreator } from 'zustand'
import type { ImageGenConnectionsSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'

export const createImageGenConnectionsSlice: StateCreator<ImageGenConnectionsSlice> = (set) => ({
  imageGenProfiles: [],
  activeImageGenConnectionId: null,
  imageGenProviders: [],

  setImageGenProfiles: (profiles) => set({ imageGenProfiles: profiles }),

  setActiveImageGenConnection: (id) => {
    set({ activeImageGenConnectionId: id })
    // Persist active connection to backend settings
    settingsApi.get('imageGeneration').then((row) => {
      const current = row?.value || {}
      settingsApi.put('imageGeneration', { ...current, activeImageGenConnectionId: id })
    }).catch(() => {})
  },

  addImageGenProfile: (profile) =>
    set((state) => ({ imageGenProfiles: [...state.imageGenProfiles, profile] })),

  updateImageGenProfile: (id, updates) =>
    set((state) => ({
      imageGenProfiles: state.imageGenProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeImageGenProfile: (id) =>
    set((state) => ({
      imageGenProfiles: state.imageGenProfiles.filter((p) => p.id !== id),
      activeImageGenConnectionId:
        state.activeImageGenConnectionId === id ? null : state.activeImageGenConnectionId,
    })),

  setImageGenProviders: (providers) => set({ imageGenProviders: providers }),
})
