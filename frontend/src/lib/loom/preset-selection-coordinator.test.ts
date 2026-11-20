import { describe, expect, test } from 'bun:test'
import { createPresetSelectionCoordinator } from './preset-selection-coordinator-core'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('preset selection coordinator', () => {
  test('keeps the working preset when a malformed target is rejected', async () => {
    let activePresetId = 'working'
    const flushed: string[] = []
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (id) => { activePresetId = id! },
      flushPreset: async (id) => { flushed.push(id) },
      resolvePresetId: async (id) => ({ presetId: id === 'malformed' ? 'working' : id }),
    })
    expect(await coordinator.transition('malformed')).toBe(false)
    expect(activePresetId).toBe('working')
    expect(flushed).toEqual([])
  })

  test('a newer selection wins while target validation is pending', async () => {
    let activePresetId = 'working'
    const validation = deferred<boolean>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (id) => { activePresetId = id! },
      flushPreset: async () => {},
      resolvePresetId: async (id) => {
        if (id === 'slow') await validation.promise
        return { presetId: id }
      },
    })
    const slow = coordinator.transition('slow')
    await Promise.resolve()
    await Promise.resolve()
    const latest = coordinator.transition('latest')
    validation.resolve(true)
    expect(await slow).toBe(false)
    expect(await latest).toBe(true)
    expect(activePresetId).toBe('latest')
  })

  test('recovery preserves malformed pending data instead of flushing it', async () => {
    let activePresetId = 'malformed'
    const flushed: string[] = []
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (id) => { activePresetId = id! },
      flushPreset: async (id) => { flushed.push(id) },
      resolvePresetId: async (id) => ({ presetId: id }),
    })
    expect(await coordinator.transition('fallback', { recoverFromPresetId: 'malformed' })).toBe(true)
    expect(activePresetId).toBe('fallback')
    expect(flushed).toEqual([])
    expect(await coordinator.transition('next', { recoverFromPresetId: 'malformed' })).toBe(true)
    expect(flushed).toEqual(['fallback'])
  })

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
})
