export interface FrontendExtensionCleanupResources {
  deactivatePresetEditor(): void
  clearPresetEditorSubscriptions(): void
  destroyPlacements(): void
  cleanupProcesses(): void
  teardown?(): void
  reportTeardownError?(error: unknown): void
  drainEventSubscriptions(): void
  cleanupDomAndMounts(): void
  cleanupRegistries(): void
}

/**
 * Coordinates one extension's teardown lifecycle. The loader supplies the
 * concrete resource callbacks; the seam keeps ordering and idempotence
 * testable without loading a real extension.
 */
export function createFrontendExtensionCleanup(
  resources: FrontendExtensionCleanupResources,
): (reportTeardownError?: boolean) => void {
  let cleanupComplete = false
  let teardownInvoked = false
  return (reportTeardownError = false): void => {
    if (cleanupComplete) return
    cleanupComplete = true

    resources.deactivatePresetEditor()
    try {
      resources.clearPresetEditorSubscriptions()
    } catch {
      // no-op
    }
    try {
      resources.destroyPlacements()
    } catch {
      // no-op
    }
    resources.cleanupProcesses()

    if (!teardownInvoked) {
      teardownInvoked = true
      try {
        resources.teardown?.()
      } catch (error) {
        if (reportTeardownError) resources.reportTeardownError?.(error)
      }
    }

    resources.drainEventSubscriptions()
    resources.cleanupDomAndMounts()
    resources.cleanupRegistries()
  }
}

/**
 * Shared branch finalization for setup failures and superseded generations.
 * A synchronous stale setup return becomes the teardown exactly once before
 * the idempotent cleanup routine runs.
 */
export function finalizeFrontendLoadFailure(
  cleanup: ((reportTeardownError?: boolean) => void) | undefined,
  loaded: { teardown?: () => void },
  options: { superseded: boolean; teardownResult?: unknown },
): void {
  if (options.superseded && typeof options.teardownResult === 'function') {
    loaded.teardown = options.teardownResult as () => void
  }
  cleanup?.()
}

export function adoptFrontendSetupTeardown(
  loaded: { teardown?: () => void },
  resolved: unknown,
  isCurrent: boolean,
  reportError?: (error: unknown) => void,
): void {
  if (typeof resolved !== 'function') return
  if (isCurrent) {
    loaded.teardown = resolved as () => void
    return
  }
  try {
    ;(resolved as () => void)()
  } catch (error) {
    reportError?.(error)
  }
}
