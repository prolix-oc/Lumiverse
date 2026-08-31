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

export type ActiveLoomPresetSelectionBlocker = (presetId: string | null) => boolean

export interface ActiveLoomPresetSelectionBlockerRegistration {
  /** Retire this blocker after its protected draft is durably clean. */
  release(): void
  /** Retire this blocker without replaying an intent it held back. */
  cancel(): void
}

let presetSelectionCoordinator: PresetSelectionCoordinator | null = null
let unconfiguredWarningLogged = false
const activeSelectionBlockers = new Set<ActiveLoomPresetSelectionBlocker>()
let blockedSelectionReplay: {
  owner: symbol
  presetId: string | null
  replay(): void
  cancel(): void
} | null = null

function isActiveLoomPresetSelectionBlocked(presetId: string | null): boolean {
  for (const blocker of activeSelectionBlockers) {
    if (blocker(presetId)) return true
  }
  return false
}

export function registerActiveLoomPresetSelectionBlocker(
  blocker: ActiveLoomPresetSelectionBlocker,
): ActiveLoomPresetSelectionBlockerRegistration {
  activeSelectionBlockers.add(blocker)
  let active = true
  const retire = () => {
    if (!active) return false
    active = false
    activeSelectionBlockers.delete(blocker)
    return true
  }
  return {
    release() {
      if (!retire() || !blockedSelectionReplay) return
      if (isActiveLoomPresetSelectionBlocked(blockedSelectionReplay.presetId)) return
      const replay = blockedSelectionReplay
      blockedSelectionReplay = null
      replay.replay()
    },
    cancel() {
      if (!retire() || !blockedSelectionReplay) return
      const replay = blockedSelectionReplay
      blockedSelectionReplay = null
      replay.cancel()
    },
  }
}

function createNoOpPresetSelectionCoordinator(): PresetSelectionCoordinator {
  return {
    begin: () => ({
      isCurrent: () => false,
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
  const request = getPresetSelectionCoordinator().begin(options)
  if (options?.signal?.aborted) return request
  const owner = Symbol('preset-selection-request')
  let closed = false
  let transitionTarget: string | null | undefined
  let transitionPromise: Promise<boolean> | null = null
  const cleanup = () => options?.signal?.removeEventListener('abort', cancel)
  const retire = () => {
    if (closed) return
    closed = true
    request.cancel()
    cleanup()
  }
  const cancel = () => {
    const replay = blockedSelectionReplay?.owner === owner
      ? blockedSelectionReplay
      : null
    if (replay) blockedSelectionReplay = null
    if (replay) replay.cancel()
    else retire()
  }
  options?.signal?.addEventListener('abort', cancel, { once: true })
  return {
    isCurrent: () => !closed && request.isCurrent(),
    transition(presetId) {
      if (transitionPromise) {
        return transitionTarget === presetId
          ? transitionPromise
          : Promise.resolve(false)
      }
      if (closed || options?.signal?.aborted || !request.isCurrent()) {
        retire()
        return Promise.resolve(false)
      }
      transitionTarget = presetId
      if (isActiveLoomPresetSelectionBlocked(presetId)) {
        transitionPromise = new Promise<boolean>((resolve, reject) => {
          const replay = {
            owner,
            presetId,
            replay() {
              if (closed) {
                resolve(false)
                return
              }
              void request.transition(presetId)
                .then(resolve, reject)
                .finally(() => {
                  closed = true
                  cleanup()
                })
            },
            cancel() {
              retire()
              resolve(false)
            },
          }
          const superseded = blockedSelectionReplay
          blockedSelectionReplay = replay
          superseded?.cancel()
        })
        return transitionPromise
      }
      transitionPromise = request.transition(presetId).finally(() => {
        closed = true
        cleanup()
      })
      return transitionPromise
    },
    cancel,
  }
}

export function transitionActiveLoomPreset(
  presetId: string | null,
  options?: PresetSelectionTransitionOptions,
): Promise<boolean> {
  return beginActiveLoomPresetSelection(options).transition(presetId)
}
