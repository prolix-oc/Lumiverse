import type { StateCreator } from 'zustand'
import type { AppStore, ImageGenConnectionsSlice } from '@/types/store'
import type { ImageGenConnectionProfile } from '@/types/api'
import { hasPendingSetting, persistKey } from './settings'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

function resolveActiveConnectionId(
  profiles: AppStore['imageGenProfiles'],
  preferredId: string | null | undefined,
): string | null {
  if (preferredId && profiles.some((profile) => profile.id === preferredId)) return preferredId
  return profiles.find((profile) => profile.is_default)?.id ?? null
}

function persistImageGeneration(imageGeneration: AppStore['imageGeneration']) {
  persistKey('imageGeneration', imageGeneration)
}

export const createImageGenConnectionsSlice: StateCreator<AppStore, [], [], ImageGenConnectionsSlice> = (set, get) => ({
  imageGenProfiles: [],
  imageGenProfilesLoaded: false,
  imageGenProfilesVersion: 0,
  activeImageGenConnectionId: null,
  imageGenProviders: [],

  setImageGenProfiles: (profiles, expectedVersion) => {
    const state = get()
    if (expectedVersion !== undefined && expectedVersion !== state.imageGenProfilesVersion) return
    const imageGenProfiles = reorderProfiles(
      profiles,
      normalizeConnectionsOrder(state.connectionsOrder).imageGen,
    )

    const savedConnectionId = state.imageGeneration.activeImageGenConnectionId ?? null
    const activeImageGenConnectionId = resolveActiveConnectionId(
      imageGenProfiles,
      savedConnectionId ?? state.activeImageGenConnectionId,
    )
    const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
      ? state.imageGeneration
      : { ...state.imageGeneration, activeImageGenConnectionId }
    const shouldPersistReconciledConnection =
      state.fullSettingsLoaded
      && (
        activeImageGenConnectionId !== savedConnectionId
        || hasPendingSetting('imageGeneration')
      )

    set({
      imageGenProfiles,
      imageGenProfilesLoaded: true,
      imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
      activeImageGenConnectionId,
      imageGeneration,
    })

    if (shouldPersistReconciledConnection) {
      persistImageGeneration(imageGeneration)
    }
  },

  setActiveImageGenConnection: (id) => {
    get().setImageGenSettings({ activeImageGenConnectionId: id })
  },

  addImageGenProfile: (profile) => {
    const state = get()
    const imageGenProfiles = [...state.imageGenProfiles, profile]
    const activeImageGenConnectionId = resolveActiveConnectionId(
      imageGenProfiles,
      state.imageGeneration.activeImageGenConnectionId ?? state.activeImageGenConnectionId,
    )
    const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
      ? state.imageGeneration
      : { ...state.imageGeneration, activeImageGenConnectionId }
    const activeChanged = imageGeneration !== state.imageGeneration
    const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
    const order = connectionsOrder.imageGen
    set({
      imageGenProfiles,
      imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
      activeImageGenConnectionId,
      imageGeneration,
      connectionsOrder: { ...connectionsOrder, imageGen: [...order, profile.id] },
    })
    if (activeChanged) {
      if (state.fullSettingsLoaded) {
        persistImageGeneration(imageGeneration)
      } else {
        get().setImageGenSettings({ activeImageGenConnectionId })
      }
    }
  },

  updateImageGenProfile: (id, updates) => {
    const state = get()
    const imageGenProfiles = state.imageGenProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
    const activeImageGenConnectionId = resolveActiveConnectionId(
      imageGenProfiles,
      state.imageGeneration.activeImageGenConnectionId ?? state.activeImageGenConnectionId,
    )
    const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
      ? state.imageGeneration
      : { ...state.imageGeneration, activeImageGenConnectionId }
    const activeChanged = imageGeneration !== state.imageGeneration
    set({
      imageGenProfiles,
      imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
      activeImageGenConnectionId,
      imageGeneration,
    })
    if (activeChanged) {
      if (state.fullSettingsLoaded) {
        persistImageGeneration(imageGeneration)
      } else {
        get().setImageGenSettings({ activeImageGenConnectionId })
      }
    }
  },

  removeImageGenProfile: (id) => {
    const state = get()
    const imageGenProfiles = state.imageGenProfiles.filter((p) => p.id !== id)
    const activeImageGenConnectionId = resolveActiveConnectionId(
      imageGenProfiles,
      state.activeImageGenConnectionId === id ? null : state.activeImageGenConnectionId,
    )
    const imageGeneration = state.imageGeneration.activeImageGenConnectionId === activeImageGenConnectionId
      ? state.imageGeneration
      : { ...state.imageGeneration, activeImageGenConnectionId }
    const activeChanged = imageGeneration !== state.imageGeneration
    set({
      imageGenProfiles,
      imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
      activeImageGenConnectionId,
      imageGeneration,
    })
    if (activeChanged) {
      if (state.fullSettingsLoaded) {
        persistImageGeneration(imageGeneration)
      } else {
        get().setImageGenSettings({ activeImageGenConnectionId })
      }
    }
  },

  applyImageGenProfileOrder: (orderedIds) =>
    set((state) => {
      const imageGenProfiles = orderedIds
        .map((id) => state.imageGenProfiles.find((p) => p.id === id))
        .filter((p): p is ImageGenConnectionProfile => Boolean(p))
      const unchanged = imageGenProfiles.length === state.imageGenProfiles.length
        && imageGenProfiles.every((profile, index) => profile.id === state.imageGenProfiles[index].id)
      return unchanged
        ? {}
        : {
            imageGenProfiles,
            imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
          }
    }),

  setImageGenProviders: (providers) => set({ imageGenProviders: providers }),
})
