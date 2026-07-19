import { describe, expect, test } from 'bun:test'
import { createPresetSelectionCoordinator } from '@/lib/loom/preset-selection-coordinator-core'
import { createPresetProfileSelectionController } from './usePresetProfiles-selection'

function deferred<T>() {
  const gate = Promise.withResolvers<T>()
  return { promise: gate.promise, resolve: gate.resolve }
}

describe('preset profile selection controller', () => {
  test('does not supersede an unrelated settings request without a target', async () => {
    let activePresetId: string | null = 'preset-a'
    let beginCalls = 0
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const profiles = createPresetProfileSelectionController(() => {
      beginCalls += 1
      return coordinator.begin()
    })
    const settingsRequest = coordinator.begin()

    profiles.select(null, 'preset-a')
    profiles.select('preset-a', 'preset-a')
    profiles.cancel()

    expect(beginCalls).toBe(0)
    expect(await settingsRequest.transition('preset-settings')).toBe(true)
    expect(activePresetId).toBe('preset-settings')
  })

  test('cancels a resolved binding transition when its context changes', async () => {
    let activePresetId: string | null = 'preset-a'
    let beginCalls = 0
    const flushStarted = deferred<void>()
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushStarted.resolve()
        await pendingFlush.promise
      },
    })
    const profiles = createPresetProfileSelectionController(() => {
      beginCalls += 1
      return coordinator.begin()
    })

    const transition = profiles.select('preset-binding', 'preset-a')
    await flushStarted.promise
    profiles.cancel()
    pendingFlush.resolve()

    expect(beginCalls).toBe(1)
    expect(await transition).toBe(false)
    expect(activePresetId).toBe('preset-a')
  })

  test('allows a fresh request after the previous transition settles', async () => {
    let beginCalls = 0
    const transitions: Array<Promise<boolean>> = []
    const profiles = createPresetProfileSelectionController(() => {
      beginCalls += 1
      const transition = Promise.resolve(beginCalls === 2)
      transitions.push(transition)
      return {
        transition: async () => transition,
        cancel: () => {},
      }
    })

    expect(await profiles.select('preset-binding', 'preset-a')).toBe(false)
    expect(await profiles.select('preset-binding', 'preset-a')).toBe(true)
    expect(beginCalls).toBe(2)
  })
  test('cancels an obsolete binding when the resolved target returns to current', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushStarted = deferred<void>()
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushStarted.resolve()
        await pendingFlush.promise
      },
    })
    const profiles = createPresetProfileSelectionController(() => coordinator.begin())

    const transition = profiles.select('preset-binding', 'preset-a')
    await flushStarted.promise
    expect(profiles.select('preset-a', 'preset-a')).toBeNull()
    pendingFlush.resolve()

    expect(await transition).toBe(false)
    expect(activePresetId).toBe('preset-a')
  })

  test('cancels an obsolete binding when no target remains', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushStarted = deferred<void>()
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushStarted.resolve()
        await pendingFlush.promise
      },
    })
    const profiles = createPresetProfileSelectionController(() => coordinator.begin())

    const transition = profiles.select('preset-binding', 'preset-a')
    await flushStarted.promise
    expect(profiles.select(null, 'preset-a')).toBeNull()
    pendingFlush.resolve()

    expect(await transition).toBe(false)
    expect(activePresetId).toBe('preset-a')
  })

  test('supersedes a pending binding transition when a newer target resolves', async () => {
    let activePresetId: string | null = 'preset-a'
    let flushCount = 0
    const firstFlushStarted = deferred<void>()
    const firstFlush = deferred<void>()
    const flushed: string[] = []
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async (presetId) => {
        flushed.push(presetId)
        flushCount += 1
        if (flushCount === 1) {
          firstFlushStarted.resolve()
          await firstFlush.promise
        }
      },
    })
    const profiles = createPresetProfileSelectionController(() => coordinator.begin())

    const first = profiles.select('preset-b', 'preset-a')
    await firstFlushStarted.promise
    const second = profiles.select('preset-c', 'preset-a')
    firstFlush.resolve()

    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(flushed).toEqual(['preset-a', 'preset-a'])
    expect(activePresetId).toBe('preset-c')
  })

  test('does not restart selection for repeated calls of the same pending target', async () => {
    let activePresetId: string | null = 'preset-a'
    let beginCalls = 0
    let flushes = 0
    const flushStarted = deferred<void>()
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushes += 1
        flushStarted.resolve()
        await pendingFlush.promise
      },
    })
    const profiles = createPresetProfileSelectionController(() => {
      beginCalls += 1
      return coordinator.begin()
    })

    const first = profiles.select('preset-binding', 'preset-a')
    await flushStarted.promise
    const second = profiles.select('preset-binding', 'preset-a')
    pendingFlush.resolve()

    expect(first).toBe(second)
    expect(beginCalls).toBe(1)
    expect(flushes).toBe(1)
    expect(await first).toBe(true)
    expect(activePresetId).toBe('preset-binding')
  })

  test('transitions to a later target in the same stable context after the prior one committed', async () => {
    let activePresetId: string | null = 'preset-a'
    let beginCalls = 0
    const flushed: string[] = []
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async (presetId) => { flushed.push(presetId) },
    })
    const profiles = createPresetProfileSelectionController(() => {
      beginCalls += 1
      return coordinator.begin()
    })

    expect(await profiles.select('preset-b', 'preset-a')).toBe(true)
    expect(await profiles.select('preset-c', 'preset-b')).toBe(true)

    expect(beginCalls).toBe(2)
    expect(flushed).toEqual(['preset-a', 'preset-b'])
    expect(activePresetId).toBe('preset-c')
  })
})
