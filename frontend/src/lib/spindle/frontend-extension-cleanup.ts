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
  loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> },
  options: { superseded: boolean; teardownResult?: unknown },
): void {
  if (options.superseded && typeof options.teardownResult === 'function') {
    const teardown = options.teardownResult as () => void
    if (loaded.teardownClaimed) {
      invokeStaleTeardown(loaded, teardown)
    } else {
      loaded.teardown = teardown
    }
  }
  cleanup?.()
}

function invokeStaleTeardown(
  loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> },
  teardown: () => void,
  reportError?: (error: unknown) => void,
): void {
  if (loaded.teardownClaimed && loaded.teardown === teardown) return
  const staleTeardowns = loaded.staleTeardowns ??= new Set<() => void>()
  if (staleTeardowns.has(teardown)) return
  // Claim before invocation so a re-entrant or repeated resolution cannot run
  // the same stale teardown twice.
  staleTeardowns.add(teardown)
  try {
    teardown()
  } catch (error) {
    reportError?.(error)
  }
}

export function adoptFrontendSetupTeardown(
  loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> },
  resolved: unknown,
  isCurrent: boolean,
  reportError?: (error: unknown) => void,
): void {
  if (typeof resolved !== 'function') return
  const teardown = resolved as () => void
  if (isCurrent && !loaded.teardownClaimed) {
    loaded.teardown = teardown
    return
  }
  invokeStaleTeardown(loaded, teardown, reportError)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function'
}

export function observeFrontendSetupTeardown(
  result: unknown,
  loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> },
  isCurrent: () => boolean,
  onCurrentError: (error: unknown) => void,
  reportStaleTeardownError?: (error: unknown) => void,
): void {
  if (!isPromiseLike(result)) return
  void Promise.resolve(result)
    .then((resolved) => {
      adoptFrontendSetupTeardown(loaded, resolved, isCurrent(), reportStaleTeardownError)
    })
    .catch((error) => {
      if (isCurrent()) onCurrentError(error)
    })
}

/**
 * An initial permission response may only be adopted when no permission
 * change event was observed after that request started.
 */
export function isPermissionBootstrapCurrent(readVersion: number, eventVersion: number): boolean {
  return readVersion === eventVersion
}
