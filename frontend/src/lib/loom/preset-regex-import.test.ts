import { describe, expect, test } from 'bun:test'
import { bindImportedRegexesToPreset } from './preset-regex-import'

describe('preset regex import binding', () => {
  test('replaces stale ownership from an exported preset', () => {
    const scripts = bindImportedRegexesToPreset([
      { name: 'Legacy regex', find_regex: 'old', preset_id: 'old-preset', disabled: false },
      { name: 'Unbound regex', find_regex: 'new' },
    ], 'new-preset')

    expect(scripts).toEqual([
      { name: 'Legacy regex', find_regex: 'old', preset_id: 'new-preset', disabled: false },
      { name: 'Unbound regex', find_regex: 'new', preset_id: 'new-preset' },
    ])
  })

  test('leaves malformed entries intact for endpoint validation', () => {
    expect(bindImportedRegexesToPreset([null, 'invalid', []], 'new-preset')).toEqual([
      null,
      'invalid',
      [],
    ])
  })
})
