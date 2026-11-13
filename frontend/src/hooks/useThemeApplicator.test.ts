/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test'
import { isOpaqueThemeColor, toOpaqueRgb, withPreservedAlpha } from '../theme/themeColor'
import type { CharacterThemeOverlay, ThemeConfig } from '../types/theme'
import { DEFAULT_THEME } from '../theme/presets'
import { generateThemeVariables } from '../theme/engine'
import { themeControls } from '../lib/deviceThemeControls'

mock.module('@/store', () => ({
  useStore: Object.assign(() => undefined, { getState: () => ({}) }),
}))

const { buildResolvedThemeVars, resolveDesktopSurfaceColor, resolveDesktopSurface, applyGlassAttributes } = await import('./useThemeApplicator')

const glassBase = {
  ...DEFAULT_THEME,
  enableGlass: true,
  liquidGlass: true,
  renderingMode: 'balanced' as const,
}

describe('applyGlassAttributes', () => {
  test('sets both glass attributes only when the layers are live', () => {
    applyGlassAttributes(glassBase, false)
    expect(document.documentElement.hasAttribute('data-glass')).toBe(true)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(true)
  })

  test('drops the refraction layer when the base glass layer is off', () => {
    applyGlassAttributes({ ...glassBase, enableGlass: false }, false)
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(false)
  })

  test('drops the refraction layer when reduced motion is requested', () => {
    applyGlassAttributes(glassBase, true)
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(false)
  })

  test('drops the refraction layer in efficiency mode', () => {
    applyGlassAttributes({ ...glassBase, renderingMode: 'efficiency' }, false)
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(false)
  })

  test('clears a previously set refraction attribute when it is turned off', () => {
    applyGlassAttributes(glassBase, false)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(true)
    applyGlassAttributes({ ...glassBase, liquidGlass: false }, false)
    expect(document.documentElement.hasAttribute('data-liquid-glass')).toBe(false)
  })
})

describe('toOpaqueRgb', () => {
  test('converts character-aware CSS Color 4 RGB values for native PWA chrome', () => {
    expect(toOpaqueRgb('rgb(18 14 22)')).toBe('rgb(18, 14, 22)')
    expect(toOpaqueRgb(' #112233ff ')).toBe('rgb(17, 34, 51)')
  })

  test('supports slash alpha in space-separated RGB values', () => {
    expect(toOpaqueRgb('rgb(18 14 22 / 50%)')).toBe('rgb(9, 7, 11)')
  })

  test('keeps supporting legacy comma-separated RGBA values', () => {
    expect(toOpaqueRgb('rgba(18, 14, 22, 0.5)')).toBe('rgb(9, 7, 11)')
  })

  test('keeps supporting the HSL values emitted by built-in themes', () => {
    expect(toOpaqueRgb('hsla(0, 0%, 50%, 0.5)')).toBe('rgb(64, 64, 64)')
  })
})

describe('withPreservedAlpha', () => {
  test('uses the live palette color while retaining the configured tint opacity', () => {
    expect(withPreservedAlpha('rgb(18 14 22)', 'rgb(16 12 28 / 72%)'))
      .toBe('rgb(18 14 22 / 0.72)')
  })

  test('returns no recolor when the saved tint is not parseable', () => {
    expect(withPreservedAlpha('rgb(18 14 22)', 'not-a-color')).toBeNull()
  })
})

describe('character-aware desktop tint', () => {
  test('uses the active character palette while retaining the configured opacity', () => {
    const theme: ThemeConfig = {
      id: 'character-aware',
      name: 'Character Aware',
      mode: 'dark',
      accent: { h: 263, s: 55, l: 65 },
      radiusScale: 1,
      enableGlass: true,
      fontScale: 1,
      characterAware: true,
      desktopBackground: { color: 'rgb(16 12 28 / 72%)' },
    }
    const characterPalette: CharacterThemeOverlay = {
      accent: { h: 340, s: 70, l: 60 },
      baseColors: { backgroundDeep: 'rgb(18 14 22)' },
      baseColorsLight: { backgroundDeep: 'rgb(235 229 238)' },
    }

    const resolved = buildResolvedThemeVars(theme, characterPalette, {}, {}, 'dark')

    expect(resolved.hasPaletteOverride).toBeTrue()
    expect(resolveDesktopSurfaceColor(resolved.config, resolved.vars, resolved.hasPaletteOverride))
      .toBe('rgb(18 14 22 / 0.72)')
  })

  test('keeps the configured tint until a character palette is available', () => {
    const theme: ThemeConfig = {
      id: 'character-aware',
      name: 'Character Aware',
      mode: 'dark',
      accent: { h: 263, s: 55, l: 65 },
      radiusScale: 1,
      enableGlass: true,
      fontScale: 1,
      characterAware: true,
      desktopBackground: { color: 'rgb(16 12 28 / 72%)' },
    }

    const resolved = buildResolvedThemeVars(theme, null, {}, {}, 'dark')

    expect(resolved.hasPaletteOverride).toBeFalse()
    expect(resolveDesktopSurfaceColor(resolved.config, resolved.vars, resolved.hasPaletteOverride))
      .toBe('rgb(16 12 28 / 72%)')
  })
})


describe('native desktop surface policy', () => {
  const config: ThemeConfig = {
    id: 'surface', name: 'Surface', mode: 'dark', accent: { h: 263, s: 55, l: 65 },
    radiusScale: 1, enableGlass: false, fontScale: 1,
  }

  test.each(['#123', '#112233ff', 'rgb(18 14 22)', 'rgba(18, 14, 22, 1)', 'hsl(0, 0%, 50%)'])(
    'uses an opaque host for an opaque theme: %s', (color) => {
      const surface = resolveDesktopSurface({ ...config, desktopBackground: { color, blur: true } }, {}, false)
      expect(surface.surfaceMode).toBe('opaque')
      expect(surface.blur).toBeFalse()
    },
  )

  test.each(['#1238', 'rgb(18 14 22 / 75%)', 'transparent', 'var(--surface)', 'var(--surface, hsl(0, 0%, 50%))', '#gggggg'])(
    'preserves translucency or an unknown CSS color: %s', (color) => {
      expect(isOpaqueThemeColor(color)).toBeFalse()
      expect(resolveDesktopSurface({ ...config, desktopBackground: { color, blur: true } }, {}, false).surfaceMode)
        .toBe('translucent')
    },
  )

  test('efficiency makes both the native host and page opaque, even for unparseable colors', () => {
    const surface = resolveDesktopSurface({ ...config, renderingMode: 'efficiency', desktopBackground: { color: 'var(--unknown)', blur: true } }, {}, false)
    expect(surface).toEqual({ surfaceMode: 'opaque', background: 'rgb(10, 8, 18)', nativeColor: [10, 8, 18], blur: false })
  })

  test('uses the resolved palette rather than assuming that a missing desktop tint is opaque', () => {
    expect(resolveDesktopSurface(config, { '--lumiverse-bg-deep': 'rgb(1 2 3 / 50%)' }, false).surfaceMode).toBe('translucent')
    expect(resolveDesktopSurface(config, { '--lumiverse-bg-deep': '#121212' }, false).surfaceMode).toBe('opaque')
  })

  test('character recoloring retains the transparency decision', () => {
    const themed = { ...config, desktopBackground: { color: 'rgb(81 26 42 / 75%)', blur: true } }
    const surface = resolveDesktopSurface(themed, { '--lumiverse-bg-deep': 'rgb(18 14 22)' }, true)
    expect(surface.surfaceMode).toBe('translucent')
    expect(surface.blur).toBeTrue()
    expect(surface.nativeColor).toEqual([14, 11, 17])
  })
})


describe('device theme controls', () => {
  test.each([false, true])('uses local glass opacity throughout a Spindle palette (glass: %s)', (enableGlass) => {
    const theme = { ...DEFAULT_THEME, enableGlass: !enableGlass }
    const accent = { h: 120, s: 50, l: 60 }
    // applyPalette generates these maps on the server using the synced theme.
    const overrides = { fixture: {
      extensionId: 'fixture', extensionName: 'Fixture', variables: {}, paletteAccent: accent,
      variablesByMode: { dark: generateThemeVariables({ ...theme, accent }, 'dark') },
    } }
    const controls = themeControls({ enableGlass })
    const resolved = buildResolvedThemeVars(theme, null, overrides, {}, 'dark', controls)
    const expected = generateThemeVariables({ ...theme, ...controls, accent }, 'dark')
    for (const key of ['--lumiverse-bg', '--lumiverse-bg-elevated', '--lumiverse-bg-hover',
      '--lumiverse-surface', '--lumiverse-surface-raised', '--lumiverse-surface-hover',
      '--lcs-glass-bg', '--lcs-glass-bg-hover', '--lcs-glass-border', '--lcs-glass-border-hover']) {
      // Compare alpha independently of the extension's chosen surface color.
      expect(withPreservedAlpha('#ffffff', resolved.vars[key])).toBe(withPreservedAlpha('#ffffff', expected[key]))
    }
  })

  test.each([false, true])('preserves extension glass surface colors when enabling local scale controls (full theme: %s)', (full) => {
    const variables = full
      ? generateThemeVariables({ ...DEFAULT_THEME, accent: { h: 120, s: 50, l: 60 } }, 'dark')
      : { '--lcs-glass-bg': 'rgba(12, 30, 18, 0.55)', '--lcs-glass-bg-hover': 'rgba(18, 40, 24, 0.65)' }
    const overrides = { fixture: { extensionId: 'fixture', extensionName: 'Fixture', variables } }
    const before = buildResolvedThemeVars(DEFAULT_THEME, null, overrides, {}, 'dark')
    const after = buildResolvedThemeVars(DEFAULT_THEME, null, overrides, {}, 'dark', themeControls({ uiScale: 0.75 }))
    for (const key of ['--lcs-glass-bg', '--lcs-glass-bg-hover']) {
      expect(toOpaqueRgb(after.vars[key])).toBe(toOpaqueRgb(before.vars[key]))
    }
  })

  test.each(['dark', 'light'] as const)('resolves device controls without changing authored values in %s mode', (mode) => {
    const theme = { ...DEFAULT_THEME, fontScale: 1.2, uiScale: 1.1 }
    const controls = themeControls({ radiusScale: 1.5, fontScale: 0.9, uiScale: 0.75, enableGlass: false })
    const resolved = buildResolvedThemeVars(theme, null, {}, {}, mode, controls)
    expect(resolved.config).toMatchObject(controls)
    expect(resolved.vars).toMatchObject({
      '--lumiverse-font-scale': '0.9', '--lumiverse-ui-scale': '0.75',
      '--lumiverse-radius': '12px', '--lcs-radius': '21px', '--lcs-glass-blur': '0px',
    })
    expect(theme).toMatchObject({ fontScale: 1.2, uiScale: 1.1 })
    expect(buildResolvedThemeVars(theme, null, {}, {}, mode).vars['--lumiverse-ui-scale']).toBe('1.1')
  })

  test.each([false, true])('keeps local preference tokens above extension overrides (full theme: %s)', (full) => {
    const variables: Record<string, string> = {
      '--lumiverse-ui-scale': '1.5', '--lumiverse-font-scale': '2',
      '--lcs-glass-blur': '20px', '--lumiverse-radius': '40px', '--lumiverse-primary': '#ff0000',
    }
    if (full) for (let i = 0; i < 40; i++) variables[`--fixture-${i}`] = '1'
    const overrides = { fixture: { extensionId: 'fixture', extensionName: 'Fixture', variables, paletteAccent: { h: 120, s: 50, l: 60 } } }
    if (full) delete overrides.fixture.paletteAccent
    const controls = themeControls({ uiScale: 0.75, fontScale: 0.9, enableGlass: false, radiusScale: 1 })
    const resolved = buildResolvedThemeVars(DEFAULT_THEME, null, overrides, {}, 'dark', controls)
    expect(resolved.vars).toMatchObject({
      '--lumiverse-ui-scale': '0.75', '--lumiverse-font-scale': '0.9',
      '--lcs-glass-blur': '0px', '--lumiverse-radius': '8px', '--lumiverse-primary': '#ff0000',
    })
    expect(buildResolvedThemeVars(DEFAULT_THEME, null, overrides, {}, 'dark').vars['--lumiverse-ui-scale']).toBe('1.5')
  })
})
