import type { StateCreator } from 'zustand'
import type { FloatingAvatarSlice } from '@/types/store'

export const createFloatingAvatarSlice: StateCreator<FloatingAvatarSlice> = (set) => ({
  floatingAvatar: null,

  openFloatingAvatar: (imageUrl, displayName) =>
    set({
      floatingAvatar: {
        imageUrl,
        displayName,
        x: -1,
        y: -1,
        width: 280,
        height: 280,
      },
    }),

  updateFloatingAvatar: (partial) =>
    set((state) => {
      if (!state.floatingAvatar) return state
      return { floatingAvatar: { ...state.floatingAvatar, ...partial } }
    }),

  closeFloatingAvatar: () => set({ floatingAvatar: null }),
})
