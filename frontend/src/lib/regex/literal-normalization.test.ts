import { describe, expect, test } from 'bun:test'
import type { RegexScript } from '@/types/regex'
import { applyLiteralDisplayNormalization } from './literal-normalization'

const cleanup = {
  id: 'braille-cleanup', find_regex: String.raw`\u2800`, flags: 'g', replace_string: ' ',
  substitute_macros: 'none', trim_strings: [], actions: [], metadata: {},
} as unknown as RegexScript

describe('literal display normalization', () => {
  test('character cleanup agrees with native replacement across streamed prefixes', () => {
    const content = 'Hello⠀there, ⠀ friend.😀'
    for (const find_regex of ['⠀', '[⠀]', String.raw`\u2800`, String.raw`[\u2800]`, String.raw`\u{2800}`]) {
      for (const substitute_macros of ['none', 'find', 'raw', 'escaped', 'after'] as const) {
        const script = { ...cleanup, find_regex, substitute_macros, flags: 'gu' }
        for (let end = 0; end <= content.length; end++) {
          const prefix = content.slice(0, end)
          expect(applyLiteralDisplayNormalization(prefix, [script]))
            .toBe(prefix.replace(new RegExp(find_regex, 'gu'), ' '))
        }
      }
    }
  })

  test('preserves script ordering and handles Unicode code points', () => {
    expect(applyLiteralDisplayNormalization('a⠀b', [cleanup, { ...cleanup, find_regex: ' ', replace_string: '_' }])).toBe('a_b')
    expect(applyLiteralDisplayNormalization('hi😀!', [{ ...cleanup, find_regex: String.raw`[\u{1f600}]`, flags: 'gu' }])).toBe('hi !')
    expect(applyLiteralDisplayNormalization('a⠀b', [{ ...cleanup, replace_string: '' }])).toBe('ab')
  })

  test('skips other nonmatching scripts but respects matches introduced by cleanup', () => {
    const capture = { ...cleanup, find_regex: String.raw`\[STATUS\](.*?)\[/STATUS\]`, replace_string: '<div>$1</div>' }
    expect(applyLiteralDisplayNormalization('a⠀b', [capture, cleanup])).toBe('a b')
    expect(applyLiteralDisplayNormalization('a⠀b', [cleanup, capture])).toBe('a b')
    expect(applyLiteralDisplayNormalization('[STA⠀TUS]value[/STATUS]', [{ ...cleanup, replace_string: '' }, capture])).toBeUndefined()
  })

  test('leaves matching logic, effects and unsupported replacements to the isolated pipeline', () => {
    const variants: Partial<RegexScript>[] = [
      { find_regex: '(⠀)' }, { find_regex: '⠀+' }, { find_regex: '[⠀ ]' },
      { find_regex: '[^⠀]' }, { find_regex: '⠀?' }, { find_regex: '[a-z]' },
      { find_regex: String.raw`\uD800`, flags: 'gu' }, { find_regex: String.raw`\u{110000}`, flags: 'gu' },
      { flags: '' }, { flags: 'gi' }, { flags: 'gy' }, { flags: 'gg' }, { flags: 'gv' },
      { replace_string: '$&' }, { replace_string: '$1' }, { replace_string: "$'" },
      { replace_string: '{{getvar::value}}' }, { replace_string: 'long replacement' },
      { trim_strings: ['trim'] }, { actions: [{} as never] },
      { metadata: { match_actions: ['repeat_back'] } },
      { metadata: { regex_evidence: { quarantined: true } } },
    ]
    for (const [index, variant] of variants.entries()) {
      const script = { ...cleanup, ...variant, id: `unsupported-${index}` }
      expect(applyLiteralDisplayNormalization('a⠀b\ud800', [script])).toBeUndefined()
      expect(applyLiteralDisplayNormalization('a⠀b\ud800', [script, cleanup])).toBeUndefined()
    }
    expect(applyLiteralDisplayNormalization('text', [])).toBeUndefined()
  })

  test('retains macro resolution, including delimiters created between replacements', () => {
    const after = { ...cleanup, substitute_macros: 'after' as const, replace_string: '' }
    expect(applyLiteralDisplayNormalization('{{user}}⠀hello', [after])).toBeUndefined()
    expect(applyLiteralDisplayNormalization('{⠀{user}}', [after])).toBeUndefined()
    expect(applyLiteralDisplayNormalization('<us⠀er>', [after])).toBeUndefined()
    expect(applyLiteralDisplayNormalization('{{user}}⠀hello', [cleanup])).toBe('{{user}} hello')
  })
})
