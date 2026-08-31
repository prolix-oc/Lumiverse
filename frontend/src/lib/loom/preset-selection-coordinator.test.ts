import { describe, expect, test } from 'bun:test'
import { createPresetSelectionCoordinator } from './preset-selection-coordinator-core'
import {
  beginActiveLoomPresetSelection,
  configurePresetSelectionCoordinator,
  registerActiveLoomPresetSelectionBlocker,
} from './preset-selection-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('preset selection coordinator', () => {
  test('flushes the departing preset before exposing the next one', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushed: string[] = []
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async (presetId) => {
        flushed.push(presetId)
        await pendingFlush.promise
      },
    })

    const transition = coordinator.transition('preset-b')
    await Promise.resolve()
    await Promise.resolve()
    expect(activePresetId).toBe('preset-a')
    expect(flushed).toEqual(['preset-a'])

    pendingFlush.resolve()
    await transition
    expect(activePresetId).toBe('preset-b')
  })

  test('does not expose an aborted lifecycle selection after its flush completes', async () => {
    let activePresetId: string | null = 'preset-a'
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => { await pendingFlush.promise },
    })
    const abort = new AbortController()
    const transition = coordinator.transition('preset-b', { signal: abort.signal })
    await Promise.resolve()
    await Promise.resolve()

    abort.abort()
    pendingFlush.resolve()
    await transition

    expect(activePresetId).toBe('preset-a')
  })

  test('ignores a request whose lifecycle was cancelled before it reached selection', async () => {
    let activePresetId: string | null = 'preset-a'
    let flushes = 0
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => { flushes += 1 },
    })
    const abort = new AbortController()
    abort.abort()

    await coordinator.transition('preset-b', { signal: abort.signal })
    expect(activePresetId).toBe('preset-a')
    expect(flushes).toBe(0)
  })

  test('rejects an older asynchronous intent after a later manual selection commits', async () => {
    let activePresetId: string | null = 'preset-a'
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })

    const createIntent = coordinator.begin()
    expect(await coordinator.transition('preset-b')).toBe(true)
    expect(await createIntent.transition('preset-c')).toBe(false)
    expect(activePresetId).toBe('preset-b')
  })

  test('keeps a manual selection authoritative when a delayed settings read resolves later', async () => {
    let activePresetId: string | null = 'preset-a'
    const pendingManualFlush = deferred<void>()
    const manualFlushStarted = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        manualFlushStarted.resolve()
        await pendingManualFlush.promise
      },
    })
    const pendingSettingsRead = deferred<string>()
    const settingsSelection = coordinator.begin()
    const delayedSettingsSelection = pendingSettingsRead.promise.then((presetId) => settingsSelection.transition(presetId))
    const manualSelection = coordinator.transition('preset-c')

    await manualFlushStarted.promise
    pendingSettingsRead.resolve('preset-a')
    expect(await delayedSettingsSelection).toBe(false)
    pendingManualFlush.resolve()
    await manualSelection

    expect(activePresetId).toBe('preset-c')
  })


  test('does not expose a stale intermediate target after a later switch request', async () => {
    let activePresetId: string | null = 'preset-a'
    const exposed: (string | null)[] = []
    const firstFlush = deferred<void>()
    let flushes = 0
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        exposed.push(presetId)
        activePresetId = presetId
      },
      flushPreset: async () => {
        flushes += 1
        if (flushes === 1) await firstFlush.promise
      },
    })

    const staleTransition = coordinator.transition('preset-b')
    await Promise.resolve()
    await Promise.resolve()
    const currentTransition = coordinator.transition('preset-c')
    firstFlush.resolve()
    await Promise.all([staleTransition, currentTransition])

    expect(exposed).toEqual(['preset-c'])
    expect(activePresetId).toBe('preset-c')
  })

  test('keeps the original blocked request pending until its owner explicitly releases it', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const registration = registerActiveLoomPresetSelectionBlocker((presetId) => (
      presetId !== activePresetId
    ))
    const request = beginActiveLoomPresetSelection()
    const transition = request.transition('preset-b')
    let settled: boolean | undefined
    void transition.then((result) => { settled = result })

    await Promise.resolve()

    expect(settled).toBeUndefined()
    expect(request.isCurrent()).toBe(true)
    expect(activePresetId).toBe('preset-a')

    registration.release()

    expect(await transition).toBe(true)
    expect(request.isCurrent()).toBe(false)
    expect(activePresetId).toBe('preset-b')
  })

  test('replays only the newest blocked request in chronological order', async () => {
    let activePresetId: string | null = 'preset-a'
    const exposed: string[] = []
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        activePresetId = presetId
        exposed.push(presetId)
      },
      flushPreset: async () => {},
    })
    const blockedTargets: Array<string | null> = []
    const registration = registerActiveLoomPresetSelectionBlocker((presetId) => {
      blockedTargets.push(presetId)
      return true
    })

    const staleTransition = beginActiveLoomPresetSelection().transition('preset-b')
    const currentTransition = beginActiveLoomPresetSelection().transition('preset-c')

    expect(await staleTransition).toBe(false)
    expect(activePresetId).toBe('preset-a')
    registration.release()

    expect(await currentTransition).toBe(true)
    expect(exposed).toEqual(['preset-c'])
    expect(blockedTargets).toEqual(['preset-b', 'preset-c'])
  })

  test('does not let an older delayed transition displace a newer blocked request', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const blockedTargets: Array<string | null> = []
    const registration = registerActiveLoomPresetSelectionBlocker((presetId) => {
      blockedTargets.push(presetId)
      return true
    })
    const older = beginActiveLoomPresetSelection()
    const newer = beginActiveLoomPresetSelection()
    const newerTransition = newer.transition('preset-c')

    expect(await older.transition('preset-b')).toBe(false)
    expect(older.isCurrent()).toBe(false)
    expect(newer.isCurrent()).toBe(true)
    registration.release()

    expect(await newerTransition).toBe(true)
    expect(activePresetId).toBe('preset-c')
    expect(blockedTargets).toEqual(['preset-c'])
  })

  test('replays through the original request fence instead of starting a fresh request', async () => {
    let activePresetId: string | null = 'preset-a'
    const exposed: string[] = []
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        activePresetId = presetId
        exposed.push(presetId)
      },
      flushPreset: async () => {},
    })
    const registration = registerActiveLoomPresetSelectionBlocker((presetId) => presetId === 'preset-b')
    const blockedTransition = beginActiveLoomPresetSelection().transition('preset-b')

    expect(await beginActiveLoomPresetSelection().transition('preset-c')).toBe(true)
    registration.release()

    expect(await blockedTransition).toBe(false)
    expect(activePresetId).toBe('preset-c')
    expect(exposed).toEqual(['preset-c'])
  })

  test('waits until every blocking owner releases the clean draft', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const firstRegistration = registerActiveLoomPresetSelectionBlocker(() => true)
    const secondRegistration = registerActiveLoomPresetSelectionBlocker(() => true)
    const transition = beginActiveLoomPresetSelection().transition('preset-b')
    let settled: boolean | undefined
    void transition.then((result) => { settled = result })

    firstRegistration.release()
    await Promise.resolve()

    expect(settled).toBeUndefined()
    expect(activePresetId).toBe('preset-a')

    secondRegistration.release()

    expect(await transition).toBe(true)
    expect(activePresetId).toBe('preset-b')
  })

  test('drops a blocked replay when its bound-selection lifecycle is cancelled', async () => {
    let activePresetId: string | null = 'preset-a'
    let selectionChanges = 0
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        activePresetId = presetId
        selectionChanges += 1
      },
      flushPreset: async () => {},
    })
    const registration = registerActiveLoomPresetSelectionBlocker(() => true)
    const selection = beginActiveLoomPresetSelection()
    const transition = selection.transition('stale-preset')

    selection.cancel()

    expect(await transition).toBe(false)
    registration.release()
    await Promise.resolve()
    expect(activePresetId).toBe('preset-a')
    expect(selectionChanges).toBe(0)
  })

  test('cancels a blocked replay when its blocker owner retires', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const registration = registerActiveLoomPresetSelectionBlocker(() => true)
    const transition = beginActiveLoomPresetSelection().transition('stale-preset')

    registration.cancel()

    expect(await transition).toBe(false)
    expect(activePresetId).toBe('preset-a')
  })

  test('cancels a replay in flight when its originating context ends', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushStarted = deferred<void>()
    const releaseFlush = deferred<void>()
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushStarted.resolve()
        await releaseFlush.promise
      },
    })
    const registration = registerActiveLoomPresetSelectionBlocker(() => true)
    const selection = beginActiveLoomPresetSelection()
    const transition = selection.transition('stale-preset')

    registration.release()
    await flushStarted.promise
    selection.cancel()
    releaseFlush.resolve()

    expect(await transition).toBe(false)
    expect(activePresetId).toBe('preset-a')
  })

  test('does not retain a replay for an already-aborted selection', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const abort = new AbortController()
    abort.abort()
    const registration = registerActiveLoomPresetSelectionBlocker(() => true)
    const selection = beginActiveLoomPresetSelection({ signal: abort.signal })

    expect(selection.isCurrent()).toBe(false)
    expect(await selection.transition('stale-preset')).toBe(false)
    registration.release()
    await Promise.resolve()
    expect(activePresetId).toBe('preset-a')
  })
})
