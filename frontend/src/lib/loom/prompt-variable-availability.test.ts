/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import type { PromptVariableDef } from './types'
import {
  hasPromptVariableDefinitions,
  inspectPromptVariablesAvailability,
} from './prompt-variable-availability'

const promptVariable: PromptVariableDef = {
  id: 'tone',
  name: 'tone',
  label: 'Tone',
  type: 'text',
  defaultValue: 'warm',
}

describe('prompt variable availability', () => {
  test('requires at least one prompt variable definition', () => {
    expect(hasPromptVariableDefinitions(undefined)).toBe(false)
    expect(hasPromptVariableDefinitions([])).toBe(false)
    expect(hasPromptVariableDefinitions([{}])).toBe(false)
    expect(hasPromptVariableDefinitions([{ variables: [] }])).toBe(false)
    expect(hasPromptVariableDefinitions([{ variables: [promptVariable] }])).toBe(true)
  })

  test('returns availability for the current preset revision', async () => {
    await expect(inspectPromptVariablesAvailability({
      presetId: 'preset-a',
      registryUpdatedAt: 42,
      loadBlocks: async () => [{ variables: [promptVariable] }],
      isCurrent: () => true,
    })).resolves.toEqual({
      presetId: 'preset-a',
      registryUpdatedAt: 42,
      hasDefinitions: true,
    })
  })

  test('discards a result after the selected preset changes', async () => {
    await expect(inspectPromptVariablesAvailability({
      presetId: 'preset-a',
      registryUpdatedAt: 42,
      loadBlocks: async () => [{ variables: [promptVariable] }],
      isCurrent: () => false,
    })).resolves.toBeNull()
  })
})
