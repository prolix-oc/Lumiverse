import { describe, expect, test } from 'bun:test'
import { createPresetSelectionCoordinator } from './preset-selection-coordinator-core'

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
