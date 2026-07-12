import { afterEach, describe, expect, test } from 'bun:test'
import {
  createPresetEditorScopedHelper,
  getPresetEditorState,
  setPresetEditorController,
  subscribePresetEditorState,
  syncPresetEditorState,
} from './preset-editor-helper'
import { createPresetEditorAccess } from './preset-editor-access'
import type { SpindlePresetEditorDraft, SpindlePresetEditorState } from './preset-editor-types'
import { SPINDLE_EXTENSION_METADATA_KEY } from '@/lib/loom/service'

function draft(): SpindlePresetEditorDraft {
  return {
    id: 'preset-1',
    name: 'Preset',
    blocks: [],
    parameters: {},
    prompts: {},
    metadata: {
      promptVariables: { 'block-1': { tone: 'neutral' } },
      another_extension: { preserved: true },
    },
    createdAt: 1,
    updatedAt: 2,
  }
}

afterEach(() => { setPresetEditorController(null) })

describe('scoped preset editor helper', () => {
  test('clones Main fields and mutates only its identifier namespace', () => {
    let current = draft()
    let activeTab = 'preset'
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: activeTab,
        preset: current,
      }),
      setActiveTab(tabId) { activeTab = tabId },
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })

    const helper = createPresetEditorScopedHelper('agentic_preset_composer', {
      assertActive() {},
      trackSubscription(unsubscribe) { return unsubscribe },
    })

    const state = helper.getState()
    ;(state.promptVariableValues as Record<string, Record<string, string>>)['block-1'].tone = 'changed locally'
    expect(current.metadata.promptVariables).toEqual({ 'block-1': { tone: 'neutral' } })

    helper.setMetadata({ mode: 'parallel' }, { immediate: true })
    expect(current.metadata).toEqual({
      promptVariables: { 'block-1': { tone: 'neutral' } },
      another_extension: { preserved: true },
      [SPINDLE_EXTENSION_METADATA_KEY]: {
        agentic_preset_composer: { mode: 'parallel' },
      },
    })

    helper.activateBuiltinTab('blocks')
    expect(activeTab).toBe('preset')
  })

  test('rejects a retained helper after the controller closes during a preset switch', () => {
    let current = draft()
    let open = true
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open,
        presetId: open ? current.id : null,
        activeTabId: 'preset',
        preset: open ? current : null,
      }),
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('agentic_preset_composer', {
      assertActive() {},
      trackSubscription(unsubscribe) { return unsubscribe },
    })

    open = false
    expect(() => helper.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_CLOSED')
    expect(current.metadata[SPINDLE_EXTENSION_METADATA_KEY]).toBeUndefined()
  })

  test('publishes a closed state before exposing the next selected preset', () => {
    const observed: SpindlePresetEditorState[] = []
    const unsubscribe = subscribePresetEditorState((state) => observed.push(state))

    const first = draft()
    syncPresetEditorState({
      open: true,
      presetId: first.id,
      activeTabId: 'preset',
      preset: first,
    })
    const next = { ...draft(), id: 'preset-2' }
    syncPresetEditorState({
      open: true,
      presetId: next.id,
      activeTabId: 'preset',
      preset: next,
    })

    expect(observed).toHaveLength(3)
    expect(observed[0]).toMatchObject({ open: true, presetId: 'preset-1' })
    expect(observed[1]).toMatchObject({ open: false, presetId: null, preset: null })
    expect(observed[2]).toMatchObject({ open: true, presetId: 'preset-2' })
    unsubscribe()
  })

  test('makes a synthetic close authoritative while notifying listeners', () => {
    const first = draft()
    const next = { ...draft(), id: 'preset-2' }
    let updates = 0
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: next.id,
        activeTabId: 'preset',
        preset: next,
      }),
      setActiveTab() {},
      updatePreset() { updates += 1 },
      async flush() {},
    })
    syncPresetEditorState({
      open: true,
      presetId: first.id,
      activeTabId: 'preset',
      preset: first,
    })
    const helper = createPresetEditorScopedHelper('agentic_preset_composer', {
      assertActive() {},
      trackSubscription(unsubscribe) { return unsubscribe },
    })
    const readsDuringClose: SpindlePresetEditorState[] = []
    const unsubscribe = subscribePresetEditorState((state) => {
      if (state.open) return
      readsDuringClose.push(getPresetEditorState())
      expect(() => helper.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_CLOSED')
    })

    syncPresetEditorState({
      open: true,
      presetId: next.id,
      activeTabId: 'preset',
      preset: next,
    })

    expect(readsDuringClose).toEqual([expect.objectContaining({ open: false, presetId: null, preset: null })])
    expect(updates).toBe(0)
    unsubscribe()
  })

  test('keeps colliding extension identifiers separate from Loom-owned metadata', () => {
    let current: SpindlePresetEditorDraft = {
      ...draft(),
      metadata: {
        ...draft().metadata,
        source: { type: 'native-source' },
        description: 'Native description',
      },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })

    const source = createPresetEditorScopedHelper('source', {
      assertActive() {},
      trackSubscription(unsubscribe) { return unsubscribe },
    })
    const description = createPresetEditorScopedHelper('description', {
      assertActive() {},
      trackSubscription(unsubscribe) { return unsubscribe },
    })
    source.setMetadata({ mode: 'parallel' })
    description.setMetadata({ mode: 'single' })

    expect(current.metadata.source).toEqual({ type: 'native-source' })
    expect(current.metadata.description).toBe('Native description')
    expect(current.metadata[SPINDLE_EXTENSION_METADATA_KEY]).toEqual({
      source: { mode: 'parallel' },
      description: { mode: 'single' },
    })
    expect(source.getState().metadata).toEqual({ mode: 'parallel' })
    expect(description.getState().metadata).toEqual({ mode: 'single' })
  })

  test('rejects use after a permission revocation invalidates access', () => {
    let active = false
    const helper = createPresetEditorScopedHelper('agentic_preset_composer', {
      assertActive() {
        if (!active) throw new Error('PRESET_EDITOR_REVOKED')
      },
      trackSubscription(unsubscribe) { return unsubscribe },
    })

    expect(() => helper.getState()).toThrow('PRESET_EDITOR_REVOKED')
    active = true
    expect(() => helper.setMetadata({ mode: 'single' })).toThrow('PRESET_EDITOR_CLOSED')
  })

  test('invalidates retained helpers while allowing a newly acquired helper after regrant', () => {
    let current = draft()
    let permissions = ['presets']
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const access = createPresetEditorAccess(
      'agentic_preset_composer',
      () => permissions,
      (unsubscribe) => unsubscribe,
    )

    const retained = access.acquire()
    permissions = []
    access.revoke()
    expect(() => access.acquire()).toThrow('PERMISSION_DENIED:presets')
    permissions = ['presets']
    expect(() => retained.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_REVOKED')

    const reacquired = access.acquire()
    reacquired.setMetadata({ mode: 'parallel' })
    expect(current.metadata[SPINDLE_EXTENSION_METADATA_KEY]).toEqual({
      agentic_preset_composer: { mode: 'parallel' },
    })

  })
  test('permanently invalidates helpers when the extension frontend unloads', () => {
    const access = createPresetEditorAccess(
      'agentic_preset_composer',
      () => ['presets'],
      (unsubscribe) => unsubscribe,
    )
    const retained = access.acquire()
    access.dispose()

    expect(() => access.acquire()).toThrow('PRESET_EDITOR_DISPOSED')
    expect(() => retained.getState()).toThrow('PRESET_EDITOR_DISPOSED')
  })
})
