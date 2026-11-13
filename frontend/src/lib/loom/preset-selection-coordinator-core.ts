export interface PresetSelectionAdapter {
  getActivePresetId(): string | null
  setActivePresetId(presetId: string | null): void
  flushPreset(presetId: string): Promise<void>
  /** Resolve malformed targets to a usable preset before exposing them to editors or bound profiles. */
  resolvePresetId?(presetId: string, currentPresetId: string | null, isCurrent: () => boolean): Promise<{
    presetId: string
    recoverFromPresetId?: string
  } | null>
}


export interface PresetSelectionTransitionOptions {
  signal?: AbortSignal
  /** A failed hydration cannot safely flush this source; retain its recovery data untouched. */
  recoverFromPresetId?: string
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
          let targetPresetId = presetId
          let recoverFromPresetId = options.recoverFromPresetId
          if (presetId && adapter.resolvePresetId) {
            const source = adapter.getActivePresetId()
            const resolved = await adapter.resolvePresetId(presetId, source, () => !isStale() && adapter.getActivePresetId() === source)
            if (!resolved) return false
            targetPresetId = resolved.presetId
            recoverFromPresetId = resolved.recoverFromPresetId ?? recoverFromPresetId
          }
          if (isStale()) return false
          while (true) {
            const currentPresetId = adapter.getActivePresetId()
            if (currentPresetId === targetPresetId) return targetPresetId === presetId
            if (currentPresetId && currentPresetId !== recoverFromPresetId) await adapter.flushPreset(currentPresetId)
            if (isStale()) return false

            // An external lifecycle transition changed the source while this
            // transition was flushing. Rebase that source before continuing.
            if (adapter.getActivePresetId() !== currentPresetId) continue
            adapter.setActivePresetId(targetPresetId)
            return targetPresetId === presetId
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
