import { describe, expect, test } from 'bun:test'
import {
  adoptFrontendSetupTeardown,
  createFrontendExtensionCleanup,
  finalizeFrontendLoadFailure,
  isPermissionBootstrapCurrent,
  observeFrontendSetupTeardown,
  type FrontendExtensionCleanupResources,
} from './frontend-extension-cleanup'

function invokeLoadedTeardown(loaded: { teardown?: () => void; teardownClaimed?: boolean }): void {
  if (loaded.teardownClaimed) return
  const teardown = loaded.teardown
  if (!teardown) return
  loaded.teardownClaimed = true
  teardown()
}

function resources(teardown: () => void, events: string[]): FrontendExtensionCleanupResources {
  return {
    deactivatePresetEditor: () => { events.push('revoke') },
    clearPresetEditorSubscriptions: () => { events.push('subscriptions') },
    destroyPlacements: () => { events.push('placements') },
    cleanupProcesses: () => { events.push('processes') },
    teardown,
    drainEventSubscriptions: () => { events.push('events') },
    cleanupDomAndMounts: () => { events.push('dom') },
    cleanupRegistries: () => { events.push('registries') },
  }
}

describe('frontend extension cleanup lifecycle', () => {
  test('does not let a revoke event get overwritten by the in-flight permission GET', () => {
    let adopted: string[] | undefined
    const requestVersion = 0
    const revokeEventVersion = 1
    if (isPermissionBootstrapCurrent(requestVersion, revokeEventVersion)) {
      adopted = ['presets']
    }

    expect(adopted).toBeUndefined()
    expect(isPermissionBootstrapCurrent(requestVersion, requestVersion)).toBe(true)
  })
  test('setup-throw cleanup revokes authority and tears down each resource once', () => {
    const events: string[] = []
    let teardownCalls = 0
    const loaded: { teardown?: () => void } = {}
    const cleanup = createFrontendExtensionCleanup(resources(() => {
      teardownCalls += 1
      events.push('teardown')
    }, events))

    finalizeFrontendLoadFailure(cleanup, loaded, { superseded: false })
    cleanup()

    expect(events).toEqual([
      'revoke',
      'subscriptions',
      'placements',
      'processes',
      'teardown',
      'events',
      'dom',
      'registries',
    ])
    expect(teardownCalls).toBe(1)
  })

  test('superseded-generation cleanup assigns the returned teardown and runs it once', () => {
    const events: string[] = []
    let teardownCalls = 0
    const loaded: { teardown?: () => void } = {
      teardown: () => {
        teardownCalls += 1
        events.push('module-teardown')
      },
    }
    const cleanup = createFrontendExtensionCleanup(resources(() => loaded.teardown?.(), events))
    const returnedTeardown = () => {
      teardownCalls += 1
      events.push('returned-teardown')
    }

    finalizeFrontendLoadFailure(cleanup, loaded, {
      superseded: true,
      teardownResult: returnedTeardown,
    })
    cleanup()

    expect(teardownCalls).toBe(1)
    expect(events).toContain('returned-teardown')
    expect(events).not.toContain('module-teardown')
    expect(events.filter((event) => event === 'placements')).toHaveLength(1)
    expect(events.filter((event) => event === 'events')).toHaveLength(1)
  })

  test('adopts current async teardown and executes stale async teardown after cleanup', () => {
    let currentCalls = 0
    const currentLoaded: { teardown?: () => void } = {}
    const currentTeardown = () => { currentCalls += 1 }
    adoptFrontendSetupTeardown(currentLoaded, currentTeardown, true)
    currentLoaded.teardown?.()
    expect(currentCalls).toBe(1)

    let staleCalls = 0
    let staleErrors = 0
    const originalTeardown = () => { staleCalls += 1 }
    const staleLoaded: { teardown?: () => void } = { teardown: originalTeardown }
    const staleTeardown = () => { staleCalls += 1 }
    adoptFrontendSetupTeardown(staleLoaded, staleTeardown, false, () => { staleErrors += 1 })
    expect(staleLoaded.teardown).toBe(originalTeardown)
    expect(staleCalls).toBe(1)

    adoptFrontendSetupTeardown(
      staleLoaded,
      () => { throw new Error('stale teardown failed') },
      false,
      () => { staleErrors += 1 },
    )
    expect(staleErrors).toBe(1)
  })
  test('deduplicates repeated stale setup teardowns before invoking them', () => {
    let calls = 0
    let errors = 0
    const loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> } = {}
    const staleTeardown = () => { calls += 1 }

    adoptFrontendSetupTeardown(loaded, staleTeardown, false, () => { errors += 1 })
    adoptFrontendSetupTeardown(loaded, staleTeardown, false, () => { errors += 1 })

    expect(calls).toBe(1)
    expect(errors).toBe(0)
  })

  test('reports a late current setup error so the loader can dispose the extension', async () => {
    let errors = 0
    const loaded: { teardown?: () => void } = {}
    observeFrontendSetupTeardown(
      Promise.reject(new Error('setup failed late')),
      loaded,
      () => true,
      () => { errors += 1 },
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toBe(1)
  })

  test('claims static teardown before a stale async setup result settles', async () => {
    let staticCalls = 0
    let staleCalls = 0
    const loaded: { teardown?: () => void; teardownClaimed?: boolean; staleTeardowns?: Set<() => void> } = {
      teardown: () => { staticCalls += 1 },
    }
    const cleanup = createFrontendExtensionCleanup(resources(() => {
      invokeLoadedTeardown(loaded)
    }, []))
    let resolveSetup!: (teardown: () => void) => void
    const setup = new Promise<() => void>((resolve) => {
      resolveSetup = resolve
    })

    observeFrontendSetupTeardown(setup, loaded, () => false, () => {})
    cleanup()
    resolveSetup(() => { staleCalls += 1 })
    await Promise.resolve()
    await Promise.resolve()

    expect(staticCalls).toBe(1)
    expect(staleCalls).toBe(1)
  })
})
