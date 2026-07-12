import { describe, expect, test } from 'bun:test'
import {
  adoptFrontendSetupTeardown,
  createFrontendExtensionCleanup,
  finalizeFrontendLoadFailure,
  type FrontendExtensionCleanupResources,
} from './frontend-extension-cleanup'

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
})
