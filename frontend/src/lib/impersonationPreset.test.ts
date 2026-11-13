import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_IMPERSONATION_MODE,
  resolveImpersonationMode,
  resolveImpersonationModeOverride,
  resolveImpersonationPresetSelection,
} from './impersonationPreset'

describe('impersonation preset selection', () => {
  test('keeps Preset Prompts on the active chat preset', () => {
    expect(resolveImpersonationPresetSelection('prompts', 'dedicated', 'active')).toEqual({
      presetId: 'active',
      forcePresetId: false,
    })
  })

  test.each(['preset', 'oneliner'] as const)(
    '%s uses and force-selects the dedicated impersonation preset',
    (mode) => {
      expect(resolveImpersonationPresetSelection(mode, 'dedicated', 'active')).toEqual({
        presetId: 'dedicated',
        forcePresetId: true,
      })
    },
  )

  test('falls back to the active preset when no dedicated preset is configured', () => {
    expect(resolveImpersonationPresetSelection('preset', null, 'active')).toEqual({
      presetId: 'active',
      forcePresetId: false,
    })
  })

  test.each(['prompts', 'preset', 'oneliner'] as const)(
    'accepts the persisted %s preference',
    (mode) => expect(resolveImpersonationMode(mode)).toBe(mode),
  )

  test.each([undefined, null, '', 'sovereign_hand', 'invalid'])(
    'defaults invalid metadata value %p to the existing one-liner behavior',
    (value) => expect(resolveImpersonationMode(value)).toBe(DEFAULT_IMPERSONATION_MODE),
  )

  test('uses the account default only when a chat has no valid override', () => {
    expect(resolveImpersonationMode(undefined, 'preset')).toBe('preset')
    expect(resolveImpersonationMode('prompts', 'preset')).toBe('prompts')
    expect(resolveImpersonationModeOverride(undefined)).toBeNull()
    expect(resolveImpersonationModeOverride('oneliner')).toBe('oneliner')
  })
})
