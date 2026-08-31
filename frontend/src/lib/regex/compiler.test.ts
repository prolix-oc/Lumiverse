import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'
import type { RegexScript } from '@/types/regex'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/store', () => ({ useStore: { getState: () => ({}) } }))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))

const {
  REGEX_LIMITS_V1,
  applyDisplayRegex,
  applyDisplayRegexLocalLoop,
  collectRegexMatches,
  compileRegex,
  regexUtf8ByteLength,
  validateRegexScriptInput,
} = await import('./compiler')

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = []
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((arg) => String(arg)).join(' '))
  })
  return { warns, restore: () => spy.mockRestore() }
}

function script(overrides: Partial<RegexScript>): RegexScript {
  return {
    id: 'find-only',
    user_id: 'user',
    name: 'Find only',
    script_id: 'find_only',
    find_regex: '{{char}}',
    replace_string: '{{user}}',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    scope: 'global',
    scope_id: null,
    target: ['display'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'find',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

describe('find-only macro substitution', () => {
  test('resolves Find while leaving Replace unchanged', () => {
    expect(applyDisplayRegex(
      'Alice',
      [script({})],
      {
        isUser: false,
        depth: 0,
        macroCtx: { charName: 'Alice', userName: 'Bob' },
      },
    )).toBe('{{user}}')
  })
})

describe('compiled regex cache state', () => {
  test('resets sticky lastIndex around match collection', () => {
    const regex = compileRegex('a', 'y')!
    expect(collectRegexMatches('a', regex, 'a', 'y', 'x')).toHaveLength(1)
    expect(regex.lastIndex).toBe(0)
    expect(collectRegexMatches('a', regex, 'a', 'y', 'x')).toHaveLength(1)
  })
})

describe('carry-forward match replacement', () => {
  test('replaces the previous match by default', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<strong>ready</strong>')
  })

  test('can carry the original previous match', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
          repeat_raw_match: true,
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<status>ready</status>')
  })
})

describe('associative regex action captures', () => {
  test('empties an optional named capture that did not participate in the match', () => {
    const output = applyDisplayRegex(
      '<choice>North</choice>',
      [script({
        find_regex: '<choice>(?<label>[^<]+)</choice>(?:<req>(?<req>[^<]*)</req>)?',
        replace_string: '<button data-req="$<req>" data-regex-action="choose">$<label><small>$<req></small></button>',
        actions: [{
          id: 'choose',
          type: 'send',
          multi_select: false,
          cost: '1',
          limit: '3',
          title: '$<label>',
          subtitle: '$<req>',
          content: 'Choose $<label>$<req>',
        }],
      })],
      { isUser: false, depth: 0 },
    )

    expect(output).toContain('data-req=""')
    expect(output).not.toContain('$<req>')
    const encoded = output.match(/data-lumiverse-regex-action="([^"]+)"/)?.[1]
    expect(encoded).toBeTruthy()
    expect(JSON.parse(decodeURIComponent(encoded!))).toMatchObject({
      title: 'North',
      subtitle: '',
      content: 'Choose North',
    })
  })
})

describe('display regex performance reporting', () => {
  test('reports recovery for a fast run of a display flagged script', () => {
    const recovered: Array<{ elapsedMs: number }> = []
    applyDisplayRegex(
      'one',
      [script({
        find_regex: 'one',
        replace_string: 'two',
        metadata: {
          regex_performance: {
            slow: true,
            timed_out: false,
            elapsed_ms: 7200,
            threshold_ms: 5000,
            detected_at: 0,
            source: 'display_backend',
            version: 0,
            engine_version: 2,
          },
        },
      })],
      { isUser: false, depth: 0 },
      undefined,
      (report) => recovered.push({ elapsedMs: report.elapsedMs }),
    )

    expect(recovered).toHaveLength(1)
    expect(recovered[0].elapsedMs).toBeLessThan(5000)
  })
})

describe('bounded regex validation', () => {
  test('uses UTF-8 byte limits and rejects empty trim strings', () => {
    const invalid = validateRegexScriptInput({
      find_regex: '😀'.repeat(20_000),
      replace_string: '',
      flags: 'g',
      trim_strings: [],
      actions: [],
    })
    expect(invalid?.code).toBe('pattern_too_large')
    expect(compileRegex('😀'.repeat(20_000), 'g')).toBeNull()
    expect(validateRegexScriptInput({
      find_regex: 'x',
      replace_string: 'y',
      flags: 'g',
      trim_strings: [''],
      actions: [],
    })?.code).toBe('trim_string_empty')
  })

  test('empty trim strings never enter a repeated replacement loop', () => {
    expect(applyDisplayRegex(
      'x',
      [script({ find_regex: 'x', replace_string: 'y', trim_strings: [''] })],
      { isUser: false, depth: 0 },
    )).toBe('y')
  })
})

describe('exact output byte accounting', () => {
  test('accepts an exact-cap split-surrogate replacement and rejects cap plus one', () => {
    const emojiCount = Math.floor(REGEX_LIMITS_V1.maxOutputBytes / 4)
    const base = '😀'.repeat(emojiCount)
    const replacementScript = script({
      find_regex: '\\uD83D',
      replace_string: 'a',
      flags: '',
      substitute_macros: 'raw',
    })

    const atCapInput = base
    const atCapOutput = atCapInput.replace('\uD83D', 'a')
    expect(regexUtf8ByteLength(atCapInput)).toBe(REGEX_LIMITS_V1.maxInputBytes)
    expect(regexUtf8ByteLength(atCapOutput)).toBe(REGEX_LIMITS_V1.maxOutputBytes)
    expect(applyDisplayRegex(
      atCapInput,
      [replacementScript],
      { isUser: false, depth: 0 },
    )).toBe(atCapOutput)

    const overCapOutput = atCapInput.replace('\uD83D', 'aa')
    expect(regexUtf8ByteLength(overCapOutput)).toBe(REGEX_LIMITS_V1.maxOutputBytes + 1)
    expect(applyDisplayRegex(
      atCapInput,
      [{ ...replacementScript, replace_string: 'aa' }],
      { isUser: false, depth: 0 },
    )).toBe(atCapInput)
  })
})
describe('trim_strings safety', () => {
  test('sync: rejoining trim reaches empty under the iteration cap', () => {
    const { warns, restore } = captureWarns()
    try {
      expect(applyDisplayRegex(
        'seed',
        [script({
          id: 'trim-parity-sync',
          name: 'Trim parity sync',
          find_regex: 'seed',
          replace_string: 'bbcc',
          trim_strings: ['bc'],
        })],
        { isUser: false, depth: 0 },
      )).toBe('')
      expect(warns).toHaveLength(0)
    } finally {
      restore()
    }
  })

  test('async: rejoining trim reaches empty under the iteration cap', async () => {
    const { warns, restore } = captureWarns()
    try {
      const outcome = await applyDisplayRegexLocalLoop(
        'seed',
        [script({
          id: 'trim-parity-async',
          name: 'Trim parity async',
          find_regex: 'seed',
          replace_string: 'bbcc',
          trim_strings: ['bc'],
        })],
        { isUser: false, depth: 0 },
        async (templates) => templates,
      )
      expect(outcome.result).toBe('')
      expect(warns).toHaveLength(0)
    } finally {
      restore()
    }
  })

  test('sync: cap-hit stops iterating and warns with script identity', () => {
    const { warns, restore } = captureWarns()
    try {
      const output = applyDisplayRegex(
        'seed',
        [script({
          id: 'trim-cap-sync',
          name: 'Trim cap sync',
          find_regex: 'seed',
          replace_string: `${'b'.repeat(33)}${'c'.repeat(33)}`,
          trim_strings: ['bc'],
        })],
        { isUser: false, depth: 0 },
      )
      expect(output).toBe('bc')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('trim-cap-sync')
      expect(warns[0]).toContain('Trim cap sync')
      expect(warns[0]).toContain('"bc"')
    } finally {
      restore()
    }
  })

  test('async: cap-hit stops iterating and warns with script identity', async () => {
    const { warns, restore } = captureWarns()
    try {
      const outcome = await applyDisplayRegexLocalLoop(
        'seed',
        [script({
          id: 'trim-cap-async',
          name: 'Trim cap async',
          find_regex: 'seed',
          replace_string: `${'b'.repeat(33)}${'c'.repeat(33)}`,
          trim_strings: ['bc'],
        })],
        { isUser: false, depth: 0 },
        async (templates) => templates,
      )
      expect(outcome.result).toBe('bc')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('trim-cap-async')
      expect(warns[0]).toContain('Trim cap async')
    } finally {
      restore()
    }
  })

  test('sync: empty trim string is a no-op and never warns', () => {
    const { warns, restore } = captureWarns()
    try {
      expect(applyDisplayRegex(
        'hello world',
        [script({
          id: 'trim-empty-sync',
          find_regex: 'world',
          replace_string: 'world',
          trim_strings: [''],
        })],
        { isUser: false, depth: 0 },
      )).toBe('hello world')
      expect(warns).toHaveLength(0)
    } finally {
      restore()
    }
  })

  test('async: empty trim string is a no-op and never warns', async () => {
    const { warns, restore } = captureWarns()
    try {
      const outcome = await applyDisplayRegexLocalLoop(
        'hello world',
        [script({
          id: 'trim-empty-async',
          find_regex: 'world',
          replace_string: 'world',
          trim_strings: [''],
        })],
        { isUser: false, depth: 0 },
        async (templates) => templates,
      )
      expect(outcome.result).toBe('hello world')
      expect(warns).toHaveLength(0)
    } finally {
      restore()
    }
  })

  test('sync: throwing script warns with identity instead of failing silently', () => {
    const { warns, restore } = captureWarns()
    try {
      const explodingMacros = new Proxy({}, {
        get() {
          throw new Error('macro resolution exploded')
        },
      }) as unknown as DisplayMacroContext
      const output = applyDisplayRegex(
        'x',
        [script({
          id: 'error-path-sync',
          name: 'Error path sync',
          find_regex: 'x',
          replace_string: '{{boom}}',
          substitute_macros: 'raw',
        })],
        { isUser: false, depth: 0, macroCtx: explodingMacros },
      )
      expect(output).toBe('x')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('error-path-sync')
      expect(warns[0]).toContain('Error path sync')
    } finally {
      restore()
    }
  })

  test('async: rejecting raw-template resolver warns with identity', async () => {
    const { warns, restore } = captureWarns()
    try {
      const outcome = await applyDisplayRegexLocalLoop(
        'x',
        [script({
          id: 'error-path-async',
          name: 'Error path async',
          find_regex: 'x',
          replace_string: '{{boom}}',
          substitute_macros: 'raw',
        })],
        { isUser: false, depth: 0 },
        async () => {
          throw new Error('template resolution exploded')
        },
      )
      expect(outcome.result).toBe('x')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('error-path-async')
      expect(warns[0]).toContain('Error path async')
    } finally {
      restore()
    }
  })
})
