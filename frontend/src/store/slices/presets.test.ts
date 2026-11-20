import { describe, expect, test } from 'bun:test'
import { createPresetsSlice } from './presets'

describe('presets slice', () => {
  test('keeps No Preset temporary chats opted out when the global selection changes', () => {
    const state: Record<string, any> = {
      activeChatMetadata: { temporary: true, no_preset: true },
    }
    const set = (patch: Record<string, any>) => { Object.assign(state, patch) }
    Object.assign(state, createPresetsSlice(set as any, (() => state) as any, {} as any))

    state.setActiveLoomPreset('preset-a')
    expect(state.getActivePresetForGeneration()).toBeNull()
    state.setActiveLoomPreset('preset-b')
    expect(state.getActivePresetForGeneration()).toBeNull()
    expect(state.activeLoomPresetId).toBe('preset-b')

    // Leaving the temporary chat restores the selected preset for generation.
    state.activeChatMetadata = {}
    expect(state.getActivePresetForGeneration()).toBe('preset-b')
  })

  test.each([null, {}, { temporary: true }, { no_preset: true }])(
    'uses the selected preset for chats without the temporary opt-out: %j',
    (metadata) => {
      const state: Record<string, any> = { activeChatMetadata: metadata }
      const set = (patch: Record<string, any>) => { Object.assign(state, patch) }
      Object.assign(state, createPresetsSlice(set as any, (() => state) as any, {} as any))

      state.setActiveLoomPreset('preset-a')
      expect(state.getActivePresetForGeneration()).toBe('preset-a')
    },
  )

  test('persists a Loom preset switch before exposing it in state', () => {
    let state: Record<string, any> = {}
    const set = (patch: Record<string, any>) => { Object.assign(state, patch) }
    const get = () => state
    const persistCalls: Array<{ previous: string | null; id: string | null }> = []

    Object.assign(state, createPresetsSlice(set as any, get as any, {} as any))
    state.setSetting = (_key: string, id: string | null) => {
      persistCalls.push({ previous: state.activeLoomPresetId, id })
      state.activeLoomPresetId = id
    }

    state.setActiveLoomPreset('preset-b')

    expect(persistCalls).toEqual([{ previous: null, id: 'preset-b' }])
    expect(state.activeLoomPresetId).toBe('preset-b')
  })
})
