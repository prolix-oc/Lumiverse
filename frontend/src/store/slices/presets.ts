import type { StateCreator } from 'zustand'
import type { PresetsSlice } from '@/types/store'

export const createPresetsSlice: StateCreator<PresetsSlice> = (set, get) => ({
  presets: {},
  activePresetId: null,
  activeLoomPresetId: null,
  loomRegistry: {},

  setPresets: (presets) => set({ presets }),
  setActivePreset: (id) => set({ activePresetId: id }),
  setActiveLoomPreset: (id) => {
    const { setSetting } = get() as any
    set({ activeLoomPresetId: id })
    if (setSetting) setSetting('activeLoomPresetId', id)
  },
  setLoomRegistry: (registry) => set({ loomRegistry: registry }),
  getActivePresetForGeneration: () => get().activeLoomPresetId || null,
})
