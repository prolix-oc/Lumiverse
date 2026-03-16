import type { StateCreator } from 'zustand'
import type { PresetsSlice } from '@/types/store'

export const createPresetsSlice: StateCreator<PresetsSlice> = (set, get) => ({
  presets: {},
  activePresetId: null,
  activeLoomPresetId: null,
  activeLumiPresetId: null,
  loomRegistry: {},

  setPresets: (presets) => set({ presets }),
  setActivePreset: (id) => set({ activePresetId: id }),
  setActiveLoomPreset: (id) => {
    const { setSetting } = get() as any
    set({ activeLoomPresetId: id })
    if (setSetting) setSetting('activeLoomPresetId', id)
  },
  setActiveLumiPreset: (id) => {
    const { setSetting } = get() as any
    set({ activeLumiPresetId: id })
    if (setSetting) setSetting('activeLumiPresetId', id)
  },
  setLoomRegistry: (registry) => set({ loomRegistry: registry }),
  /** Prefers Lumi preset when set, falls back to Loom preset. */
  getActivePresetForGeneration: () => {
    const { activeLumiPresetId, activeLoomPresetId } = get()
    return activeLumiPresetId || activeLoomPresetId || null
  },
})
