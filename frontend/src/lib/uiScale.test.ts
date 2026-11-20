import { describe, expect, test } from 'bun:test'
import { normalizeUiScale, toLayoutDelta, toLayoutSize } from './uiScale'
import { generateThemeVariables } from '../theme/engine'
import { DEFAULT_THEME } from '../theme/presets'

describe('UI scale settings', () => {
  test('recovers from invalid saved or imported scale settings', () => {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, 0, -1, 'oops']) {
      expect(normalizeUiScale(value)).toBe(1)
      const vars = generateThemeVariables({ ...DEFAULT_THEME, uiScale: value as number }, 'dark')
      expect(vars['--lumiverse-ui-scale']).toBe('1')
    }
  })

  test('keeps valid values and constrains settings to the supported slider range', () => {
    expect(normalizeUiScale(0.5)).toBe(0.5)
    expect(normalizeUiScale(0.8)).toBe(0.8)
    expect(normalizeUiScale(1.25)).toBe(1.25)
    expect(normalizeUiScale(1.5)).toBe(1.5)
    expect(normalizeUiScale(0.01)).toBe(0.5)
    expect(normalizeUiScale(20)).toBe(1.5)
  })

  test('converts rendered pointer movement and viewport dimensions exactly once', () => {
    expect(toLayoutDelta(30, -15, 1.5)).toEqual({ x: 20, y: -10 })
    expect(toLayoutSize({ width: 1200, height: 800 }, 0.5)).toEqual({ width: 2400, height: 1600 })
  })
})
