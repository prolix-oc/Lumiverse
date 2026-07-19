export interface PresetSelectionAdapter {
  getActivePresetId(): string | null
  setActivePresetId(presetId: string | null): void
  flushPreset(presetId: string): Promise<void>
}


export interface PresetSelectionTransitionOptions {
  signal?: AbortSignal
}

export interface PresetSelectionRequest {
  transition(presetId: string | null): Promise<boolean>
  cancel(): void
}

export interface PresetSelectionCoordinator {
  begin(options?: PresetSelectionTransitionOptions): PresetSelectionRequest
  transition(presetId: string | null, options?: PresetSelectionTransitionOptions): Promise<boolean>
}

/**
 * Serializes active-preset changes. The departing preset is durably rebased and
 * flushed before the store exposes the next id. A later request or lifecycle
 * cancellation wins before an obsolete intermediate target becomes visible.
 */
export function createPresetSelectionCoordinator(adapter: PresetSelectionAdapter): PresetSelectionCoordinator {
  let chain: Promise<void> = Promise.resolve()
  let latestRequest = 0

  const begin = (options: PresetSelectionTransitionOptions = {}): PresetSelectionRequest => {
    if (options.signal?.aborted) {
      return {
        transition: async () => false,
        cancel() {},
      }
    }

    const request = ++latestRequest
    let closed = false
    const invalidate = () => {
      if (latestRequest === request) latestRequest += 1
    }
    const cleanup = () => {
      options.signal?.removeEventListener('abort', invalidate)
    }
    const cancel = () => {
      if (closed) return
      invalidate()
      closed = true
      cleanup()
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    const isStale = () => closed || options.signal?.aborted === true || request !== latestRequest

    return {
      transition(presetId) {
        if (isStale()) {
          cleanup()
          return Promise.resolve(false)
        }
        const transition = chain.catch(() => {}).then(async (): Promise<boolean> => {
          if (isStale()) return false
          while (true) {
            const currentPresetId = adapter.getActivePresetId()
            if (currentPresetId === presetId) return true
            if (currentPresetId) await adapter.flushPreset(currentPresetId)
            if (isStale()) return false

            // An external lifecycle transition changed the source while this
            // transition was flushing. Rebase that source before continuing.
            if (adapter.getActivePresetId() !== currentPresetId) continue
            adapter.setActivePresetId(presetId)
            return true
          }
        }).finally(() => {
          closed = true
          cleanup()
        })
        chain = transition.then(() => {}, () => {})
        return transition
      },
      cancel,
    }
  }

  return {
    begin,
    transition: (presetId, options) => begin(options).transition(presetId),
  }
}
