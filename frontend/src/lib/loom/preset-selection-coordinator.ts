import { useStore } from '@/store'
import { flushPresetForGeneration } from './preset-save-coordinator'
import {
  createPresetSelectionCoordinator,
  type PresetSelectionTransitionOptions,
} from './preset-selection-coordinator-core'

export {
  createPresetSelectionCoordinator,
  type PresetSelectionAdapter,
  type PresetSelectionCoordinator,
  type PresetSelectionTransitionOptions,
} from './preset-selection-coordinator-core'

const presetSelectionCoordinator = createPresetSelectionCoordinator({
  getActivePresetId: () => useStore.getState().activeLoomPresetId,
  setActivePresetId: (presetId) => useStore.getState().setActiveLoomPreset(presetId),
  flushPreset: flushPresetForGeneration,
})

export function transitionActiveLoomPreset(
  presetId: string | null,
  options?: PresetSelectionTransitionOptions,
): Promise<void> {
  return presetSelectionCoordinator.transition(presetId, options)
}
