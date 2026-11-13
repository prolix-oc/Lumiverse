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
let unconfiguredWarningLogged = false

function createNoOpPresetSelectionCoordinator(): PresetSelectionCoordinator {
  return {
    begin: () => ({
      transition: async () => false,
      cancel() {},
    }),
    transition: async () => false,
  }
}

export function configurePresetSelectionCoordinator(adapter: PresetSelectionAdapter): void {
  presetSelectionCoordinator = createPresetSelectionCoordinator(adapter)
}

function getPresetSelectionCoordinator(): PresetSelectionCoordinator {
  if (!presetSelectionCoordinator) {
    if (!unconfiguredWarningLogged) {
      unconfiguredWarningLogged = true
      console.warn(
        '[preset-selection] Coordinator not configured; using no-op fallback. ' +
        'This is expected in tests and SSR, but the app root should call configurePresetSelectionCoordinator.',
      )
    }
    return createNoOpPresetSelectionCoordinator()
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
