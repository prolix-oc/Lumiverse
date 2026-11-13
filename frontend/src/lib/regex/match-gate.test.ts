import { describe, expect, test } from 'bun:test'
import type { RegexScript } from '@/types/regex'
import { cannotMatchRegex, canSkipDisplayRegex } from './match-gate'

const script = {
  id: 'status', find_regex: String.raw`\[STATUS\]([\s\S]*?)\[/STATUS\]`,
  flags: 'g', replace_string: '$1', substitute_macros: 'none', trim_strings: [], metadata: {},
} as unknown as RegexScript

describe('display regex no-match gate', () => {
  test('incomplete delimiters need no regex execution, including a catastrophic near miss', () => {
    expect(canSkipDisplayRegex('[STATUS]incomplete[/STAT', script)).toBe(true)
    expect(canSkipDisplayRegex('[STATUS]complete[/STATUS]', script)).toBe(false)
    expect(cannotMatchRegex('ordinary prose', 'x', 'g')).toBe(true)
    expect(cannotMatchRegex('some text', 'x', 'g')).toBe(false)
    expect(cannotMatchRegex('a'.repeat(100_000), '(a+)+ENDING', 'g')).toBe(true)
    expect(cannotMatchRegex('a'.repeat(100_000) + 'ENDING', '(a+)+ENDING', 'g')).toBe(false)
  })

  test('uncertain syntax falls through and native case folding is preserved', () => {
    expect(cannotMatchRegex('foo', 'foo|barENDING', '')).toBe(false)
    expect(cannotMatchRegex('', '(ENDING)?', '')).toBe(false)
    expect(cannotMatchRegex('', 'ENDING*', '')).toBe(false)
    expect(cannotMatchRegex('foo', '[a-z]ENDING', 'v')).toBe(false)
    expect(cannotMatchRegex('ending', 'ENDING', 'i')).toBe(false)
    expect(cannotMatchRegex('\u212aELVIN', 'KELVIN', 'iu')).toBe(false)
    expect(cannotMatchRegex('\u212aELVIN', 'KELVIN', 'i')).toBe(true)
  })

  test('space cleanup scripts skip frames without their required character', () => {
    for (const pattern of ['⠀', '[⠀]', String.raw`\u2800`, String.raw`[\u2800]`, String.raw`\u{2800}`]) {
      expect(cannotMatchRegex('ordinary prose', pattern, 'gu')).toBe(true)
      expect(cannotMatchRegex('braille⠀space', pattern, 'gu')).toBe(false)
    }
    expect(cannotMatchRegex('A', '[a]', 'i')).toBe(false)
    expect(cannotMatchRegex(' ', String.raw`\x20`, 'g')).toBe(false)
    expect(cannotMatchRegex('😀', String.raw`[\u{1f600}]`, 'u')).toBe(false)
  })

  test('skipping preserves work independent of a current match', () => {
    expect(canSkipDisplayRegex('text', { ...script, trim_strings: ['', 'absent'] })).toBe(true)
    expect(canSkipDisplayRegex('text', { ...script, trim_strings: ['text'] })).toBe(false)
    expect(canSkipDisplayRegex('text', { ...script, metadata: { match_actions: ['repeat_back'] } })).toBe(false)
    expect(canSkipDisplayRegex('text', { ...script, metadata: { match_actions: {} } })).toBe(true)
    expect(canSkipDisplayRegex('{{user}}', { ...script, substitute_macros: 'after' })).toBe(false)
    expect(canSkipDisplayRegex('text', { ...script, substitute_macros: 'raw', replace_string: '{{user}}' })).toBe(true)
    expect(canSkipDisplayRegex('text', { ...script, substitute_macros: 'escaped', replace_string: '{{setvar::x::1}}' })).toBe(false)
  })

  test('macro-generated patterns require resolution and owned activation stays authoritative', () => {
    const dynamic = { ...script, find_regex: '{{pattern}}ENDING', substitute_macros: 'find' as const }
    expect(canSkipDisplayRegex('text', dynamic)).toBe(false)
    const resolved = new Map([[script.id, 'text']])
    expect(canSkipDisplayRegex('text', dynamic, resolved)).toBe(false)
    resolved.set(script.id, 'somethingENDING')
    expect(canSkipDisplayRegex('text', dynamic, resolved)).toBe(true)
    expect(canSkipDisplayRegex('text', { ...dynamic, preset_id: 'preset', metadata: { prompt_activation: {} } }, resolved)).toBe(false)
    expect(canSkipDisplayRegex('text', {
      ...dynamic, substitute_macros: 'none', preset_id: 'preset', metadata: { prompt_activation: {} },
    }, resolved)).toBe(false)
  })

  test('a negative gate agrees with native matching across representative syntax and stream splits', () => {
    const patterns = [script.find_regex, 'foo([a-z]+)ENDING', '(?:foo|bar)ENDING',
      '(?<word>foo)\\k<word>ENDING', '(?=foo)fooENDING', 'foo.*ENDING', 'foo|barENDING',
      'foo\\x45NDING', '[^x]+ENDING', '(?:fooENDING)?', 'fooENDING{0,2}', '^fooENDING$',
      '[⠀]', String.raw`\u2800`, String.raw`[\u2800]`, String.raw`\u{2800}`,
      '[a-z]', '[^a]', '[ab]', '[a]?', '[a]*', String.raw`[\s]`, String.raw`[\u{1f600}]`]
    const bodies = ['fooENDING', 'barENDING', 'foofooENDING', '[STATUS]value[/STATUS]', 'ending', 'fooENDIN', '⠀ a z', '😀']
    for (const pattern of patterns) for (const flags of ['', 'g', 'i', 'iu', 'y']) {
      for (const body of bodies) for (let end = 0; end <= body.length; end++) {
        const input = body.slice(0, end)
        if (cannotMatchRegex(input, pattern, flags)) expect(new RegExp(pattern, flags).test(input)).toBe(false)
      }
    }
  })
})
