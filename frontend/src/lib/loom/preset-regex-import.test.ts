import { describe, expect, test } from 'bun:test'
import { bindImportedRegexesToPreset } from './preset-regex-import'

describe('preset regex import binding', () => {
  test('replaces stale ownership from an exported preset', () => {
    const scripts = bindImportedRegexesToPreset([
      { name: 'Legacy regex', script_id: 'shared-id', find_regex: 'old', preset_id: 'old-preset', disabled: false },
      { name: 'Unbound regex', find_regex: 'new' },
    ], 'new-preset')

    expect(scripts).toEqual([
      {
        name: 'Legacy regex',
        script_id: '',
        find_regex: 'old',
        preset_id: 'new-preset',
        disabled: false,
        metadata: { imported_script_id: 'shared-id' },
      },
      { name: 'Unbound regex', find_regex: 'new', script_id: '', metadata: {}, preset_id: 'new-preset' },
    ])
  })

  test('preserves existing metadata while making the imported script identity local', () => {
    expect(bindImportedRegexesToPreset([{
      name: 'Reimported',
      script_id: 'publisher_script',
      metadata: { source: 'preset-export' },
    }], 'fresh-preset')).toEqual([{
      name: 'Reimported',
      script_id: '',
      metadata: { source: 'preset-export', imported_script_id: 'publisher_script' },
      preset_id: 'fresh-preset',
    }])
  })

  test('leaves malformed entries intact for endpoint validation', () => {
    expect(bindImportedRegexesToPreset([null, 'invalid', []], 'new-preset')).toEqual([
      null,
      'invalid',
      [],
    ])
  })
})
