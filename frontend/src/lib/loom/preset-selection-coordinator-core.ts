export interface PresetSelectionAdapter {
  getActivePresetId(): string | null
  setActivePresetId(presetId: string | null): void
  flushPreset(presetId: string): Promise<void>
}


export interface PresetSelectionTransitionOptions {
  signal?: AbortSignal
}

export interface PresetSelectionCoordinator {
  transition(presetId: string | null, options?: PresetSelectionTransitionOptions): Promise<void>
}

/**
 * Serializes active-preset changes. The departing preset is durably rebased and
 * flushed before the store exposes the next id. A later request or lifecycle
 * cancellation wins before an obsolete intermediate target becomes visible.
 */
export function createPresetSelectionCoordinator(adapter: PresetSelectionAdapter): PresetSelectionCoordinator {
  let chain: Promise<void> = Promise.resolve()
  let latestRequest = 0

  return {
    transition(presetId, options = {}) {
      const request = ++latestRequest
      const invalidate = () => {
        if (latestRequest === request) latestRequest += 1
      }
      options.signal?.addEventListener('abort', invalidate, { once: true })
      const isStale = () => options.signal?.aborted === true || request !== latestRequest
      const transition = chain.catch(() => {}).then(async () => {
        if (isStale()) return
        while (true) {
          const currentPresetId = adapter.getActivePresetId()
          if (currentPresetId === presetId) return
          if (currentPresetId) await adapter.flushPreset(currentPresetId)
          if (isStale()) return

          // An external lifecycle transition changed the source while this
          // transition was flushing. Rebase that source before continuing.
          if (adapter.getActivePresetId() !== currentPresetId) continue
          adapter.setActivePresetId(presetId)
          return
        }
      }).finally(() => {
        options.signal?.removeEventListener('abort', invalidate)
      })
      chain = transition.catch(() => {})
      return transition
    },
  }
}
