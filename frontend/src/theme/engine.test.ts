/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { generateThemeVariables } from './engine'
import { DEFAULT_THEME } from './presets'

describe('generateThemeVariables', () => {
  test('derives a dark accent control surface and a readable glyph in both modes', () => {
    const dark = generateThemeVariables(DEFAULT_THEME, 'dark')
    const light = generateThemeVariables(DEFAULT_THEME, 'light')

    for (const vars of [dark, light]) {
      const channels = vars['--lumiverse-primary-deep']
        .match(/\d+/g)
        ?.map(Number)

      expect(channels).toHaveLength(3)
      expect(Math.max(...(channels ?? [255]))).toBeLessThan(64)
      expect(vars['--lumiverse-primary-deep-contrast']).toMatch(/95%\)$/)
    }

    expect(dark['--lumiverse-primary-deep']).not.toBe(light['--lumiverse-primary-deep'])
  })

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
