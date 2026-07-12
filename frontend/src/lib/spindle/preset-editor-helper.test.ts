import { afterEach, describe, expect, test } from 'bun:test'
import {
  createPresetEditorScopedHelper,
  setPresetEditorController,
} from './preset-editor-helper'
import { createPresetEditorAccess } from './preset-editor-access'
import type { SpindlePresetEditorDraft, SpindlePresetEditorState } from './preset-editor-types'

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
      agentic_preset_composer: { mode: 'parallel' },
    })

    helper.activateBuiltinTab('blocks')
    expect(activeTab).toBe('preset')
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
    permissions = ['presets']
    expect(() => retained.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_REVOKED')

    const reacquired = access.acquire()
    reacquired.setMetadata({ mode: 'parallel' })
    expect(current.metadata.agentic_preset_composer).toEqual({ mode: 'parallel' })
  })
})
