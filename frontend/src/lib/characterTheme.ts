/**
 * Derives a ThemeConfig accent + base-color overlay from an extracted image palette.
 *
 * The result is designed to be merged onto the user's current theme so that the
 * UI tints itself toward the active character's color palette, while preserving
 * the user's mode, glass, radius, and font preferences.
 */

import type { ImagePalette, RGB, TextZoneBand, TextZoneCluster } from './colorExtraction'
import {
  shiftTowards,
  contrastRatio,
  constrainLuminance,
  rgbToHsl,
  hslToRgb,
  heroMaskAlpha,
  deriveCharacterOverlayFromPalette,
  deriveCharacterNameVarsFromPalette,
} from './colorExtraction'
import type { CharacterThemeOverlay } from '@/types/theme'

/** WCAG AA minimum for normal text. */
const MIN_TEXT_CONTRAST = 4.5

/**
 * Dark-mode eye-comfort ceiling: colours should never exceed this perceptual
 * luminance (0–255) so they do not glare on a dark background.
 */
const DARK_MODE_MAX_LUM = 215
/**
 * Light-mode eye-comfort floor: colours should stay above this perceptual
 * luminance (0–255) so they do not feel like harsh smudges on a light background.
 */
const LIGHT_MODE_MIN_LUM = 50

const HERO_LIGHT_TEXT: RGB = { r: 247, g: 249, b: 252 }
const HERO_DARK_TEXT: RGB = { r: 17, g: 22, b: 28 }

function rgbToCss(color: RGB): string {
  return `rgb(${color.r} ${color.g} ${color.b})`
}

function mixRgb(from: RGB, to: RGB, weight: number): RGB {
  const w = clamp(weight, 0, 1)
  return {
    r: Math.round(from.r + (to.r - from.r) * w),
    g: Math.round(from.g + (to.g - from.g) * w),
    b: Math.round(from.b + (to.b - from.b) * w),
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function luminance(color: RGB): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
}

// ── Hero text-zone contrast engine ──

interface WeightedBacking {
  color: RGB
  weight: number
}

/**
 * Composite raw image clusters with the page surface using each cluster's
 * hero-mask alpha. The rendered backing under the hero text is
 * `image·α + surface·(1−α)`, not raw pixels — the mask fades the image to
 * transparent by 95% of its height, so the lower the text row, the more the
 * page surface contributes.
 */
function compositeBand(band: TextZoneBand, surface: RGB): WeightedBacking[] {
  return band.clusters.map((c) => ({
    color: mixRgb(surface, c.color, c.alpha),
    weight: c.weight,
  }))
}

function minContrast(color: RGB, backings: WeightedBacking[]): number {
  let min = Infinity
  for (const b of backings) {
    min = Math.min(min, contrastRatio(color, b.color))
  }
  return min
}

/**
 * Like ensureContrast, but guarantees the ratio against the *worst* weighted
 * backing in the set rather than a single average color. Walks lightness in
 * HSL space (preserving hue/saturation) and returns the closest lightness
 * that clears `minRatio` against every backing, or the best-effort candidate
 * when the band is genuinely bimodal.
 */
function ensureContrastMulti(foreground: RGB, backings: WeightedBacking[], minRatio: number): RGB {
  if (backings.length === 0) return foreground
  let best = foreground
  let bestMin = minContrast(foreground, backings)
  if (bestMin >= minRatio) return foreground

  const hsl = rgbToHsl(foreground.r, foreground.g, foreground.b)
  for (let delta = 1; delta <= 100; delta++) {
    for (const l of [hsl.l + delta, hsl.l - delta]) {
      if (l < 0 || l > 100) continue
      const candidate = hslToRgb(hsl.h, hsl.s, l)
      const m = minContrast(candidate, backings)
      if (m >= minRatio) return candidate
      if (m > bestMin) {
        bestMin = m
        best = candidate
      }
    }
  }
  return best
}

interface HeroBandColors {
  text: RGB
  muted: RGB
  /** True when a significant cluster (≥15% of the band) still can't reach
   *  4.5:1 with the chosen text — i.e. the band straddles both very dark and
   *  very light content and no single color can win everywhere. */
  bimodal: boolean
}

function fallbackBand(palette: ImagePalette): TextZoneBand {
  const { regions } = palette
  const color = palette.regionExtremes?.bottom.darkest ?? {
    r: Math.round(regions.bottom.r * 0.6 + regions.center.r * 0.4),
    g: Math.round(regions.bottom.g * 0.6 + regions.center.g * 0.4),
    b: Math.round(regions.bottom.b * 0.6 + regions.center.b * 0.4),
  }
  const meanY = 0.85
  const cluster: TextZoneCluster = { color, weight: 1, meanY, alpha: heroMaskAlpha(meanY) }
  return { clusters: [cluster] }
}

/**
 * Pick a text color for one band in one mode. Polarity (light vs dark text)
 * is chosen by maximin: whichever candidate's worst-case cluster contrast is
 * stronger wins, so a large light region isn't sacrificed to a small dark one
 * (and vice versa).
 */
function deriveBandColors(band: TextZoneBand, surface: RGB, mode: 'dark' | 'light'): HeroBandColors {
  const backings = compositeBand(band, surface)
  if (backings.length === 0) {
    // Band is fully masked/transparent — the text sits on the bare surface.
    backings.push({ color: surface, weight: 1 })
  }

  // Tint the text toward the dominant cluster's hue, scaled by saturation:
  // colorful artwork tints the text, grayscale artwork stays neutral.
  const dominantCluster = band.clusters.length > 0
    ? band.clusters.reduce((a, b) => (b.weight > a.weight ? b : a))
    : null
  const tintSource = dominantCluster?.color ?? surface
  const tintW = 0.25 + 0.2 * (rgbToHsl(tintSource.r, tintSource.g, tintSource.b).s / 100)

  const lightCandidate = ensureContrastMulti(mixRgb(HERO_LIGHT_TEXT, tintSource, tintW), backings, MIN_TEXT_CONTRAST)
  const darkCandidate = ensureContrastMulti(mixRgb(HERO_DARK_TEXT, tintSource, tintW), backings, MIN_TEXT_CONTRAST)

  let text = minContrast(lightCandidate, backings) >= minContrast(darkCandidate, backings)
    ? lightCandidate
    : darkCandidate

  const dominantBacking = backings.reduce((a, b) => (b.weight > a.weight ? b : a)).color
  let muted = ensureContrastMulti(shiftTowards(text, dominantBacking, 0.28), backings, MIN_TEXT_CONTRAST)

  // Eye-comfort clamps, then re-guarantee (clamping can cost contrast).
  text = constrainLuminance(text, mode === 'light' ? LIGHT_MODE_MIN_LUM : undefined, mode === 'dark' ? DARK_MODE_MAX_LUM : undefined)
  muted = constrainLuminance(muted, mode === 'light' ? LIGHT_MODE_MIN_LUM : undefined, mode === 'dark' ? DARK_MODE_MAX_LUM : undefined)
  text = ensureContrastMulti(text, backings, MIN_TEXT_CONTRAST)
  muted = ensureContrastMulti(muted, backings, MIN_TEXT_CONTRAST)

  // Bimodal when the text materially fails somewhere: the cumulative weight
  // of clusters it can't clear crosses 15% of the band.
  let failingWeight = 0
  for (const b of backings) {
    if (contrastRatio(text, b.color) < MIN_TEXT_CONTRAST) failingWeight += b.weight
  }
  const bimodal = failingWeight >= 0.15

  return { text, muted, bimodal }
}

/**
 * Given a full image palette, compute an accent HSL and subtle base color tints
 * that make the UI feel "character-aware".
 *
 * Strategy:
 *   1. Use the dominant color's hue as the accent hue
 *   2. Boost saturation for the accent (so it reads as intentional, not muddy)
 *   3. Derive a subtle secondary from the palette
 *   4. Derive a very subtle background tint from the average color
 */
export function deriveCharacterOverlay(palette: ImagePalette): CharacterThemeOverlay {
  const overlay = deriveCharacterOverlayFromPalette(palette)
  return {
    accent: overlay.accent,
    baseColors: {
      primary: overlay.baseColors.primary,
      secondary: overlay.baseColors.secondary,
      background: overlay.baseColors.background,
      backgroundDeep: overlay.baseColors.backgroundDeep,
      text: overlay.baseColors.text,
    },
    baseColorsLight: {
      primary: overlay.baseColorsLight.primary,
      secondary: overlay.baseColorsLight.secondary,
      background: overlay.baseColorsLight.background,
      backgroundDeep: overlay.baseColorsLight.backgroundDeep,
      text: overlay.baseColorsLight.text,
    },
  }
}

/**
 * Compute hero-overlay CSS variables (for the character profile hero section).
 *
 * The backing under the hero text is not a single color: the hero image fades
 * through a CSS mask into the page surface, so each row of text sits on
 * `image·α(y) + surface·(1−α(y))`. We sample the text overlay's actual
 * footprint into run-length-deduped clusters (`palette.textZone`, split into
 * a `name` band and a `meta` band), composite each cluster with the mode's
 * page surface, and choose the light/dark text polarity by maximin WCAG
 * contrast across the significant clusters — so a large backing region is
 * never sacrificed to a small one, and genuinely bimodal bands are flagged
 * instead of silently failing.
 */
export function deriveHeroTextVars(
  palette: ImagePalette,
  /** A live DOM sample of the rendered title can replace the palette's static
   * name zone. Meta content keeps its stable lower-hero band. */
  options: { nameBand?: TextZoneBand } = {},
): Record<string, string> {
  const { dominant } = palette

  const nameBand = options.nameBand ?? palette.textZone?.name ?? fallbackBand(palette)
  const metaBand = palette.textZone?.meta ?? fallbackBand(palette)

  const nameDark = deriveBandColors(nameBand, palette.ui.dark.surface, 'dark')
  const nameLight = deriveBandColors(nameBand, palette.ui.light.surface, 'light')
  const metaDark = deriveBandColors(metaBand, palette.ui.dark.surface, 'dark')
  const metaLight = deriveBandColors(metaBand, palette.ui.light.surface, 'light')

  // Scrims for buttons/tags: opposite polarity of the chosen meta text so
  // they read clearly against the same hero backing.
  const darkScrim = luminance(metaDark.text) > 128
    ? 'rgba(0, 0, 0, 0.38)'
    : 'rgba(255, 255, 255, 0.40)'
  const lightScrim = luminance(metaLight.text) > 128
    ? 'rgba(0, 0, 0, 0.38)'
    : 'rgba(255, 255, 255, 0.40)'

  // A title can genuinely straddle bright and dark artwork. In that case no
  // foreground alone is honest; give only the title a compact, polarity-aware
  // backing. At 55% this is strong enough to make either extreme safe while
  // still leaving the art visible around the label.
  const nameScrim = (text: RGB, bimodal: boolean) => !bimodal
    ? 'transparent'
    : luminance(text) > 128
      ? 'rgba(0, 0, 0, 0.55)'
      : 'rgba(255, 255, 255, 0.55)'

  // Prefer the engine's Vibrant swatch for the hero accent: it's the most
  // intentional, saturated color in the image (hair, eyes, costume detail).
  // Fall back to the raw dominant so cached/older palettes still work.
  const vibrant = palette.swatches?.vibrant?.color
  const heroDominant = vibrant ?? dominant

  const ambientDark = palette.ambient?.dark
  const ambientLight = palette.ambient?.light

  return {
    '--hero-dominant': rgbToCss(heroDominant),
    // Name band (topmost text, over the least-faded image).
    '--hero-contrast-name-dark': rgbToCss(nameDark.text),
    '--hero-contrast-name-light': rgbToCss(nameLight.text),
    '--hero-name-scrim-dark': nameScrim(nameDark.text, nameDark.bimodal),
    '--hero-name-scrim-light': nameScrim(nameLight.text, nameLight.bimodal),
    // Meta band (edit button, creator, tags — over the fade zone).
    '--hero-contrast-dark': rgbToCss(metaDark.text),
    '--hero-contrast-light': rgbToCss(metaLight.text),
    '--hero-contrast-muted-dark': rgbToCss(metaDark.muted),
    '--hero-contrast-muted-light': rgbToCss(metaLight.muted),
    // '1' when the band is bimodal and no single color clears 4.5 everywhere.
    // The profile uses the name-specific result above to show a compact scrim.
    '--hero-text-bimodal-dark': nameDark.bimodal || metaDark.bimodal ? '1' : '0',
    '--hero-text-bimodal-light': nameLight.bimodal || metaLight.bimodal ? '1' : '0',
    '--hero-text-scrim-dark': darkScrim,
    '--hero-text-scrim-light': lightScrim,
    // Apple Music-style ambient glow derived from the same vibrant seed.
    '--hero-ambient-dark': ambientDark
      ? `radial-gradient(ellipse 120% 80% at 50% 0%, ${rgbToCss(ambientDark)} 0%, transparent 70%)`
      : 'none',
    '--hero-ambient-light': ambientLight
      ? `radial-gradient(ellipse 120% 80% at 50% 0%, ${rgbToCss(ambientLight)} 0%, transparent 70%)`
      : 'none',
  }
}

/**
 * Compute root-level CSS variables for the character's name color in chat messages.
 *
 * Unlike the hero treatment (which needs pure white/black for image contrast),
 * chat names sit on glass cards, so we use VIBRANT themed colors derived from
 * the character's avatar.
 *
 * Strategy: score all palette regions by vibrancy (saturation weighted by distance
 * from pure gray) and pick the best candidate. This avoids choosing a muddy
 * near-black dominant when the character has a colorful accent elsewhere in the
 * image (hair ribbon, eyes, background element, etc.).
 *
 * If no region is vibrant enough (monochrome artwork), falls back to the theme's
 * primary accent hue with forced saturation.
 */
export function deriveCharacterNameVars(
  palette: ImagePalette
): Record<string, string> {
  const vars = deriveCharacterNameVarsFromPalette(palette)
  return {
    '--char-name-dark': vars.dark,
    '--char-name-light': vars.light,
  }
}
