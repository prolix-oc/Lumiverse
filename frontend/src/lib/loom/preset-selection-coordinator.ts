import {
  createPresetSelectionCoordinator,
  type PresetSelectionAdapter,
  type PresetSelectionCoordinator,
  type PresetSelectionRequest,
  type PresetSelectionTransitionOptions,
} from './preset-selection-coordinator-core'

export {
  createPresetSelectionCoordinator,
  type PresetSelectionAdapter,
  type PresetSelectionCoordinator,
  type PresetSelectionTransitionOptions,
  type PresetSelectionRequest,
} from './preset-selection-coordinator-core'

let presetSelectionCoordinator: PresetSelectionCoordinator | null = null

export function configurePresetSelectionCoordinator(adapter: PresetSelectionAdapter): void {
  presetSelectionCoordinator = createPresetSelectionCoordinator(adapter)
}

function getPresetSelectionCoordinator(): PresetSelectionCoordinator {
  if (!presetSelectionCoordinator) {
    throw new Error('PRESET_SELECTION_UNAVAILABLE: Preset selection coordinator is not initialized')
  }
  return presetSelectionCoordinator
}

export function beginActiveLoomPresetSelection(
  options?: PresetSelectionTransitionOptions,
): PresetSelectionRequest {
  return getPresetSelectionCoordinator().begin(options)
}

export function transitionActiveLoomPreset(
  presetId: string | null,
  options?: PresetSelectionTransitionOptions,
): Promise<boolean> {
  return getPresetSelectionCoordinator().transition(presetId, options)
}
