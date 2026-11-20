import {
  beginActiveLoomPresetSelection,
  type PresetSelectionRequest,
} from '@/lib/loom/preset-selection-coordinator'

export type BeginPresetSelection = () => PresetSelectionRequest

export interface PresetProfileSelectionController {
  select(resolvedPresetId: string | null, currentPresetId: string | null): Promise<boolean> | null
  cancel(): void
}

/**
 * Owns the selection request created by a resolved profile binding.
 *
 * A request is reserved only when a binding resolves to a different preset;
 * callers can cancel that request when the profile context changes or unmounts.
 */
export function createPresetProfileSelectionController(
  beginSelection: BeginPresetSelection = beginActiveLoomPresetSelection,
): PresetProfileSelectionController {
  let selection: {
    target: string
    request: PresetSelectionRequest
    transition: Promise<boolean>
  } | null = null

  const cancel = () => {
    selection?.request.cancel()
    selection = null
  }

  const select = (resolvedPresetId: string | null, currentPresetId: string | null) => {
    if (!resolvedPresetId || resolvedPresetId === currentPresetId) {
      // A removed binding must retire its prior transition, but with no owned
      // request this is a no-op and cannot invalidate unrelated global work.
      cancel()
      return null
    }

    if (selection?.target === resolvedPresetId) {
      return selection.transition
    }

    // A changed binding result supersedes any transition started for the
    // previous result before reserving the new latest intent.
    cancel()
    const request = beginSelection()
    const transition = request.transition(resolvedPresetId)
      .catch(() => false)
      .finally(() => {
        if (selection?.request === request) selection = null
      })
    selection = { target: resolvedPresetId, request, transition }
    return transition
  }

  return { select, cancel }
}
