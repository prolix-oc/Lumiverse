import type { StateCreator } from 'zustand'
import type { AppStore, ImageGenConnectionsSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { clearDirtyKey } from './settings'

function resolveActiveConnectionId(
  profiles: AppStore['imageGenProfiles'],
  preferredId: string | null | undefined,
): string | null {
  if (preferredId && profiles.some((profile) => profile.id === preferredId)) return preferredId
  return profiles.find((profile) => profile.is_default)?.id ?? null
}

function persistImageGeneration(imageGeneration: AppStore['imageGeneration']) {
  settingsApi.put('imageGeneration', imageGeneration)
    .then(() => clearDirtyKey('imageGeneration'))
    .catch(() => {})
}

export const createImageGenConnectionsSlice: StateCreator<AppStore, [], [], ImageGenConnectionsSlice> = (set, get) => ({
  imageGenProfiles: [],
  activeImageGenConnectionId: null,
  imageGenProviders: [],

  setImageGenProfiles: (profiles) => set((state) => {
    const activeImageGenConnectionId = resolveActiveConnectionId(
      profiles,
      state.imageGeneration.activeImageGenConnectionId ?? state.activeImageGenConnectionId,
    )
    const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
      ? state.imageGeneration
      : { ...state.imageGeneration, activeImageGenConnectionId }

    // Profile hydration can run before full settings load on mobile/resume.
    // Do not write this derived connection choice back or it can overwrite
    // saved image prompt presets with the generation-slice defaults.
    return { imageGenProfiles: profiles, activeImageGenConnectionId, imageGeneration }
  }),

  setActiveImageGenConnection: (id) => {
    const imageGeneration = { ...get().imageGeneration, activeImageGenConnectionId: id }
    set({ activeImageGenConnectionId: id, imageGeneration } as Partial<AppStore>)
    persistImageGeneration(imageGeneration)
  },

  addImageGenProfile: (profile) =>
    set((state) => {
      const imageGenProfiles = [...state.imageGenProfiles, profile]
      const activeImageGenConnectionId = resolveActiveConnectionId(
        imageGenProfiles,
        state.imageGeneration.activeImageGenConnectionId ?? state.activeImageGenConnectionId,
      )
      const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
        ? state.imageGeneration
        : { ...state.imageGeneration, activeImageGenConnectionId }

      if (imageGeneration !== state.imageGeneration) persistImageGeneration(imageGeneration)
      return { imageGenProfiles, activeImageGenConnectionId, imageGeneration }
    }),

  updateImageGenProfile: (id, updates) =>
    set((state) => {
      const imageGenProfiles = state.imageGenProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
      const activeImageGenConnectionId = resolveActiveConnectionId(
        imageGenProfiles,
        state.imageGeneration.activeImageGenConnectionId ?? state.activeImageGenConnectionId,
      )
      const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
        ? state.imageGeneration
        : { ...state.imageGeneration, activeImageGenConnectionId }

      if (imageGeneration !== state.imageGeneration) persistImageGeneration(imageGeneration)
      return { imageGenProfiles, activeImageGenConnectionId, imageGeneration }
    }),

  removeImageGenProfile: (id) =>
    set((state) => {
      const imageGenProfiles = state.imageGenProfiles.filter((p) => p.id !== id)
      const activeImageGenConnectionId = resolveActiveConnectionId(
        imageGenProfiles,
        state.activeImageGenConnectionId === id ? null : state.activeImageGenConnectionId,
      )
      const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
        ? state.imageGeneration
        : { ...state.imageGeneration, activeImageGenConnectionId }

      if (imageGeneration !== state.imageGeneration) persistImageGeneration(imageGeneration)
      return { imageGenProfiles, activeImageGenConnectionId, imageGeneration }
    }),

  setImageGenProviders: (providers) => set({ imageGenProviders: providers }),
})
