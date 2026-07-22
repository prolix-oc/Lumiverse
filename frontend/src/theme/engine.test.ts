/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { generateThemeVariables } from './engine'
import { DEFAULT_THEME } from './presets'

describe('generateThemeVariables', () => {
  test('allows a dynamic theme to keep its deep surface separate from its app background', () => {
    const vars = generateThemeVariables({
      ...DEFAULT_THEME,
      baseColors: {
        background: 'rgb(32 42 52)',
        backgroundDeep: 'rgb(9 12 15)',
      },
    }, 'dark')

    expect(vars['--lumiverse-bg']).toBe('rgb(32 42 52)')
    expect(vars['--lumiverse-bg-deep']).toBe('rgb(9 12 15)')
  })
})
