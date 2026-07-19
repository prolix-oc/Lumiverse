import { describe, expect, test } from 'bun:test'
import { deriveHeroTextVars } from './characterTheme'
import { contrastRatio, extractTextZoneBandFromData, heroMaskAlpha, relativeLuminance } from './colorExtraction'
import type { ImagePalette, RGB, TextZoneBand, TextZoneCluster } from './colorExtraction'

function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b }
}

function cluster(color: RGB, weight: number, alpha = 1): TextZoneCluster {
  return { color, weight, meanY: 0.75, alpha }
}

function band(...clusters: TextZoneCluster[]): TextZoneBand {
  return { clusters }
}

/** Mirror of mixRgb in characterTheme.ts — pins the compositing math. */
function composite(surface: RGB, clusterColor: RGB, alpha: number): RGB {
  return {
    r: Math.round(surface.r + (clusterColor.r - surface.r) * alpha),
    g: Math.round(surface.g + (clusterColor.g - surface.g) * alpha),
    b: Math.round(surface.b + (clusterColor.b - surface.b) * alpha),
  }
}

function parseRgbVar(value: string): RGB {
  const m = value.match(/^rgb\((\d+) (\d+) (\d+)\)$/)
  if (!m) throw new Error(`Not an rgb() var: ${value}`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
}

const DARK_SURFACE = rgb(30, 34, 48)
const LIGHT_SURFACE = rgb(245, 246, 250)

function makePalette(overrides?: Partial<ImagePalette>): ImagePalette {
  const grey = rgb(128, 128, 128)
  const darkScheme = {
    surface: DARK_SURFACE,
    text: rgb(238, 241, 247),
    mutedText: rgb(160, 166, 184),
    accent: rgb(142, 108, 228),
    accentText: rgb(255, 255, 255),
  }
  const lightScheme = {
    surface: LIGHT_SURFACE,
    text: rgb(24, 28, 38),
    mutedText: rgb(92, 98, 118),
    accent: rgb(102, 68, 188),
    accentText: rgb(255, 255, 255),
  }
  const extremes = {
    top: { darkest: rgb(60, 70, 90), lightest: rgb(60, 70, 90) },
    center: { darkest: rgb(90, 100, 120), lightest: rgb(90, 100, 120) },
    bottom: { darkest: rgb(40, 45, 60), lightest: rgb(40, 45, 60) },
    left: { darkest: rgb(80, 85, 100), lightest: rgb(80, 85, 100) },
    right: { darkest: rgb(75, 80, 95), lightest: rgb(75, 80, 95) },
  }
  const defaultBand = band(cluster(rgb(40, 45, 60), 1))
  return {
    dominant: grey,
    regions: {
      top: rgb(60, 70, 90),
      center: rgb(90, 100, 120),
      bottom: rgb(40, 45, 60),
      left: rgb(80, 85, 100),
      right: rgb(75, 80, 95),
    },
    flatness: { top: 0.1, center: 0.1, bottom: 0.1, left: 0.1, right: 0.1, full: 0.1 },
    average: grey,
    isLight: false,
    palette: [grey],
    diversity: { score: 0.5, isUniform: false, usedFallback: false },
    ui: { dark: darkScheme, light: lightScheme },
    regionExtremes: extremes,
    textZone: { name: defaultBand, meta: defaultBand },
    ...overrides,
  } as ImagePalette
}

describe('deriveHeroTextVars', () => {
  test('maps a cropped title sample back to the hero mask position', () => {
    const data = new Uint8ClampedArray(2 * 2 * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 64
      data[index + 1] = 72
      data[index + 2] = 88
      data[index + 3] = 255
    }

    const band = extractTextZoneBandFromData(data, 2, 2, (sampleY) => 0.70 + sampleY * 0.01)
    expect(band.clusters).toHaveLength(1)
    expect(band.clusters[0].meanY).toBeGreaterThan(0.70)
    expect(band.clusters[0].meanY).toBeLessThan(0.72)
    expect(band.clusters[0].alpha).toBe(heroMaskAlpha(band.clusters[0].meanY))
  })

  test('prefers the Vibrant swatch for the hero dominant accent', () => {
    const palette = makePalette({
      dominant: rgb(80, 80, 80),
      swatches: {
        vibrant: { color: rgb(255, 60, 120), population: 1200, hsl: { h: 345, s: 100, l: 62 } },
        muted: null,
        darkVibrant: null,
        lightVibrant: null,
        darkMuted: null,
        lightMuted: null,
      },
    })

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-dominant']).toBe('rgb(255 60 120)')
  })

  test('falls back to the raw dominant color when no vibrant swatch exists', () => {
    const palette = makePalette({
      dominant: rgb(70, 130, 180),
      swatches: {
        vibrant: null,
        muted: { color: rgb(120, 120, 120), population: 800, hsl: { h: 0, s: 0, l: 47 } },
        darkVibrant: null,
        lightVibrant: null,
        darkMuted: null,
        lightMuted: null,
      },
    })

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-dominant']).toBe('rgb(70 130 180)')
  })

  test('emits ambient gradient variables when palette.ambient is present', () => {
    const palette = makePalette({
      ambient: {
        dark: rgb(120, 40, 80),
        light: rgb(240, 210, 225),
      },
    })

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-ambient-dark']).toContain('radial-gradient')
    expect(vars['--hero-ambient-dark']).toContain('rgb(120 40 80)')
    expect(vars['--hero-ambient-light']).toContain('radial-gradient')
    expect(vars['--hero-ambient-light']).toContain('rgb(240 210 225)')
  })

  test('emits "none" for ambient variables when palette.ambient is missing', () => {
    const palette = makePalette()
    delete (palette as any).ambient

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-ambient-dark']).toBe('none')
    expect(vars['--hero-ambient-light']).toBe('none')
  })

  test('emits all band variables for both modes', () => {
    const palette = makePalette()

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-contrast-name-dark']).toBeDefined()
    expect(vars['--hero-contrast-name-light']).toBeDefined()
    expect(vars['--hero-contrast-dark']).toBeDefined()
    expect(vars['--hero-contrast-light']).toBeDefined()
    expect(vars['--hero-contrast-muted-dark']).toBeDefined()
    expect(vars['--hero-contrast-muted-light']).toBeDefined()
    expect(vars['--hero-text-bimodal-dark']).toBe('0')
    expect(vars['--hero-text-bimodal-light']).toBe('0')
  })

  // Regression: Cissia — a light name-band majority with a dark line-art
  // minority. The old extremes-based code guaranteed contrast only against
  // the dark minority and produced light-gray text that failed (~2:1) against
  // the light majority. In light mode a clean win exists: dark text.
  test('light majority + dark minority: picks dark text that clears the light majority (light mode)', () => {
    const lightBg = rgb(242, 240, 252)
    const darkStrokes = rgb(64, 60, 82)
    const palette = makePalette({
      textZone: {
        name: band(cluster(lightBg, 0.75, 0.55), cluster(darkStrokes, 0.25, 0.55)),
        meta: band(cluster(lightBg, 1, 0.1)),
      },
    })

    const vars = deriveHeroTextVars(palette)
    const nameText = parseRgbVar(vars['--hero-contrast-name-light'])

    const lightBacking = composite(LIGHT_SURFACE, lightBg, 0.55)
    const darkBacking = composite(LIGHT_SURFACE, darkStrokes, 0.55)
    expect(contrastRatio(nameText, lightBacking)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(nameText, darkBacking)).toBeGreaterThanOrEqual(4.5)
    expect(relativeLuminance(nameText.r, nameText.g, nameText.b)).toBeLessThan(0.2)
    expect(vars['--hero-text-bimodal-light']).toBe('0')
  })

  // Regression: Kairo — a mid-tone name band composited with the dark page
  // surface. The old code measured raw pixels only and picked dark text
  // (~2.2:1 rendered). Compositing shows the true backing is dark, so the
  // text must flip light.
  test('mid-tone band over dark surface: flips to light text (dark mode)', () => {
    const sweater = rgb(133, 128, 158)
    const palette = makePalette({
      textZone: {
        name: band(cluster(sweater, 1, 0.55)),
        meta: band(cluster(sweater, 1, 0.2)),
      },
    })

    const vars = deriveHeroTextVars(palette)
    const nameText = parseRgbVar(vars['--hero-contrast-name-dark'])

    const backing = composite(DARK_SURFACE, sweater, 0.55)
    expect(contrastRatio(nameText, backing)).toBeGreaterThanOrEqual(4.5)
    expect(relativeLuminance(nameText.r, nameText.g, nameText.b)).toBeGreaterThan(0.35)
    expect(vars['--hero-text-bimodal-dark']).toBe('0')
  })

  test('a rendered title band overrides the broad static name band', () => {
    const paleSurroundingArt = rgb(250, 244, 246)
    const darkClothingUnderTitle = rgb(56, 50, 70)
    const palette = makePalette({
      textZone: {
        // This mirrors Cissia: the old broad lower-hero zone is mostly pale,
        // while the narrow title footprint lands over darker costume detail.
        name: band(cluster(paleSurroundingArt, 1, 0.52)),
        meta: band(cluster(paleSurroundingArt, 1, 0.1)),
      },
    })

    const staticVars = deriveHeroTextVars(palette)
    const renderedVars = deriveHeroTextVars(palette, {
      nameBand: band(cluster(darkClothingUnderTitle, 1, 0.62)),
    })

    const staticName = parseRgbVar(staticVars['--hero-contrast-name-dark'])
    const renderedName = parseRgbVar(renderedVars['--hero-contrast-name-dark'])
    expect(relativeLuminance(staticName.r, staticName.g, staticName.b)).toBeLessThan(0.2)
    expect(relativeLuminance(renderedName.r, renderedName.g, renderedName.b)).toBeGreaterThan(0.35)
    expect(renderedVars['--hero-name-scrim-dark']).toBe('transparent')
    // Only the name gets the live override; the lower metadata still uses its
    // stable palette band.
    expect(renderedVars['--hero-contrast-dark']).toBe(staticVars['--hero-contrast-dark'])
  })

  // A band split evenly between near-black and near-white admits no single
  // winning color — the engine must say so instead of silently failing.
  test('evenly split dark/light band sets the bimodal flag', () => {
    const palette = makePalette({
      textZone: {
        name: band(cluster(rgb(10, 10, 14), 0.5), cluster(rgb(250, 250, 252), 0.5)),
        meta: band(cluster(rgb(40, 45, 60), 1)),
      },
    })

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-text-bimodal-dark']).toBe('1')
    expect(vars['--hero-text-bimodal-light']).toBe('1')
    expect(vars['--hero-name-scrim-dark']).not.toBe('transparent')
    expect(vars['--hero-name-scrim-light']).not.toBe('transparent')
  })

  test('empty bands fall back to the page surface as the backing', () => {
    const palette = makePalette({
      textZone: { name: band(), meta: band() },
    })

    const vars = deriveHeroTextVars(palette)
    const nameText = parseRgbVar(vars['--hero-contrast-name-dark'])
    expect(contrastRatio(nameText, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5)
  })

  test('older palettes without textZone fall back to region extremes', () => {
    const palette = makePalette()
    delete (palette as any).textZone

    const vars = deriveHeroTextVars(palette)
    expect(vars['--hero-contrast-name-dark']).toBeDefined()
    expect(vars['--hero-contrast-dark']).toBeDefined()
  })
})
