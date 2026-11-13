import { describe, expect, test } from 'bun:test'
import { generateThemeVariables } from '../frontend/src/theme/engine'
import type { ThemeConfig } from '../frontend/src/types/theme'

const baseTheme: ThemeConfig = {
  id: 'test-theme',
  name: 'Test Theme',
  mode: 'dark',
  accent: { h: 263, s: 58, l: 58 },
  radiusScale: 1,
  enableGlass: false,
  fontScale: 1,
}

describe('generateThemeVariables', () => {
  test('derives companion tokens from modern rgb() overlay colors', () => {
    const vars = generateThemeVariables(
      {
        ...baseTheme,
        baseColorsByMode: {
          dark: {
            primary: 'rgb(120 82 214)',
            secondary: 'rgb(88 126 188)',
            background: 'rgb(42 46 61)',
            text: 'rgb(238 241 247)',
          },
        },
      },
      'dark'
    )

    expect(vars['--lumiverse-bg']).toBe('rgb(42 46 61)')
    expect(vars['--lumiverse-bg-elevated']).not.toBe(vars['--lumiverse-bg'])
    expect(vars['--lumiverse-bg-deep']).not.toBe(vars['--lumiverse-bg'])
    expect(vars['--lumiverse-text-muted']).toBe('rgba(238, 241, 247, 0.65)')
    expect(vars['--lumiverse-secondary']).toBe('rgba(88, 126, 188, 0.15)')
    expect(vars['--lumiverse-primary-contrast']).not.toBe('#fff')
  })
})
