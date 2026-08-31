import { describe, expect, mock, test } from 'bun:test'
import type { PresetProfileBinding } from '@/api/preset-profiles'
import type { PromptVariableValues } from '@/lib/loom/types'
import { getRuntimeAuthorityRevision } from '@/lib/agentRuntimeSelection'
import {
  getEffectivePromptVariableValues,
  subscribePresetProfilePromptVariableChanges,
  updatePresetProfilePromptVariables,
  type PresetProfilePromptVariableSource,
} from './preset-profile-prompt-variables'

const values: PromptVariableValues = { block: { tone: 'warm' } }
const binding: PresetProfileBinding = {
  preset_id: 'preset-1',
  block_states: { block: true },
  prompt_variables: values,
  captured_at: 1,
}

describe('preset profile prompt variables', () => {
  test('accepts an absent profile snapshot while presets and bindings are loading', () => {
    expect(getEffectivePromptVariableValues(undefined, {}, null)).toEqual({})
  })

  test('overlays scope-bound values and inherits missing values from the preset', () => {
    expect(getEffectivePromptVariableValues(
      'preset-1',
      { block: { tone: 'shared', length: 4 } },
      binding,
    )).toEqual({ block: { tone: 'warm', length: 4 } })

    expect(getEffectivePromptVariableValues(
      'preset-1',
      { block: { tone: 'shared' } },
      { ...binding, prompt_variables: undefined },
    )).toEqual({ block: { tone: 'shared' } })
  })

  test.each([
    ['chat', 'updateChatPromptVariables'],
    ['persona', 'updatePersonaPromptVariables'],
    ['character', 'updateCharacterPromptVariables'],
    ['connection', 'updateConnectionPromptVariables'],
    ['defaults', 'updateDefaultsPromptVariables'],
  ] as const)('routes %s saves to its profile endpoint', async (source, expectedMethod) => {
    const authorityBefore = getRuntimeAuthorityRevision()
    const api = {
      updateChatPromptVariables: mock(async () => binding),
      updatePersonaPromptVariables: mock(async () => binding),
      updateCharacterPromptVariables: mock(async () => binding),
      updateConnectionPromptVariables: mock(async () => binding),
      updateDefaultsPromptVariables: mock(async () => binding),
    }

    await expect(updatePresetProfilePromptVariables(
      api,
      { source: source as PresetProfilePromptVariableSource, id: 'profile-1' },
      values,
    )).resolves.toEqual(binding)

    expect(api[expectedMethod]).toHaveBeenCalledWith('profile-1', values)
    expect(Object.values(api).reduce((count, fn) => count + fn.mock.calls.length, 0)).toBe(1)
    expect(getRuntimeAuthorityRevision()).toBe(authorityBefore + 1)
  })

  test('does not commit authority when a profile write fails', async () => {
    const failure = new Error('write failed')
    const api = {
      updateChatPromptVariables: mock(async () => { throw failure }),
      updatePersonaPromptVariables: mock(async () => binding),
      updateCharacterPromptVariables: mock(async () => binding),
      updateConnectionPromptVariables: mock(async () => binding),
      updateDefaultsPromptVariables: mock(async () => binding),
    }
    const authorityBefore = getRuntimeAuthorityRevision()

    await expect(updatePresetProfilePromptVariables(
      api,
      { source: 'chat', id: 'chat-1' },
      values,
    )).rejects.toBe(failure)
    expect(getRuntimeAuthorityRevision()).toBe(authorityBefore)
  })

  test('publishes the committed scoped binding to other profile consumers', async () => {
    const changes: unknown[] = []
    const unsubscribe = subscribePresetProfilePromptVariableChanges((change) => changes.push(change))
    const api = {
      updateChatPromptVariables: mock(async () => binding),
      updatePersonaPromptVariables: mock(async () => binding),
      updateCharacterPromptVariables: mock(async () => binding),
      updateConnectionPromptVariables: mock(async () => binding),
      updateDefaultsPromptVariables: mock(async () => binding),
    }
    const target = { source: 'chat' as const, id: 'chat-1' }

    try {
      const committed = await updatePresetProfilePromptVariables(api, target, values)
      expect(changes).toEqual([{ target, binding: committed }])
    } finally {
      unsubscribe()
    }
  })
})
