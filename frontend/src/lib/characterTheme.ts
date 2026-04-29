/**
 * Derives a ThemeConfig accent + base-color overlay from an extracted image palette.
 *
 * The result is designed to be merged onto the user's current theme so that the
 * UI tints itself toward the active character's color palette, while preserving
 * the user's mode, glass, radius, and font preferences.
 */

import type { ImagePalette, RGB } from './colorExtraction'
import {
  rgbToHsl,
  shiftTowards,
  ensureContrast,
  hslToRgb,
  constrainLuminance,
} from './colorExtraction'
import type { CharacterThemeOverlay } from '@/types/theme'

/** Reference dark theme background (approximate) for contrast checks. */
const REF_DARK_BG: RGB = { r: 10, g: 10, b: 15 }
/** Reference light theme background (approximate) for contrast checks. */
const REF_LIGHT_BG: RGB = { r: 250, g: 250, b: 252 }
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

function rgbToCss(color: RGB): string {
  return `rgb(${color.r} ${color.g} ${color.b})`
}

function deriveSecondaryTone(seed: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const hsl = rgbToHsl(seed.r, seed.g, seed.b)
  let secondary = hslToRgb(
    hsl.h,
    clamp(hsl.s, mode === 'dark' ? 20 : 16, mode === 'dark' ? 58 : 48),
    mode === 'dark' ? clamp(hsl.l, 42, 60) : clamp(hsl.l, 30, 46)
  )

  secondary = ensureContrast(secondary, surface, MIN_TEXT_CONTRAST)
  secondary = mode === 'dark'
    ? constrainLuminance(secondary, undefined, DARK_MODE_MAX_LUM)
    : constrainLuminance(secondary, LIGHT_MODE_MIN_LUM, undefined)

  return secondary
}

/**
 * Given a full image palette, compute an accent HSL and subtle base color tints
 * that make the UI feel "character-aware".
 *
 * Strategy:
 *   1. Use the dominant color's hue as the accent hue
 *   2. Boost saturation for the accent (so it reads as intentional, not muddy)
 *   3. Derive a subtle secondary from the center region
 *   4. Derive a very subtle background tint from the average color
 */
export function deriveCharacterOverlay(palette: ImagePalette): CharacterThemeOverlay {
  const darkAccent = palette.ui.dark.accent
  const lightAccent = palette.ui.light.accent
  const primaryHsl = rgbToHsl(darkAccent.r, darkAccent.g, darkAccent.b)

  const secondarySeed = palette.palette[1] ?? palette.regions.center
  const secondaryDark = deriveSecondaryTone(secondarySeed, palette.ui.dark.surface, 'dark')
  const secondaryLight = deriveSecondaryTone(secondarySeed, palette.ui.light.surface, 'light')

  return {
    accent: { h: primaryHsl.h, s: primaryHsl.s, l: primaryHsl.l },
    baseColors: {
      primary: rgbToCss(darkAccent),
      secondary: rgbToCss(secondaryDark),
      background: rgbToCss(palette.ui.dark.surface),
      text: rgbToCss(palette.ui.dark.text),
    },
    baseColorsLight: {
      primary: rgbToCss(lightAccent),
      secondary: rgbToCss(secondaryLight),
      background: rgbToCss(palette.ui.light.surface),
      text: rgbToCss(palette.ui.light.text),
    },
  }
}

/**
 * Compute hero-overlay CSS variables (for the character profile hero section).
 *
 * Core insight: the text sits in the mask FADE ZONE where the image transitions
 * into the page background. So the effective background behind text is always
 * dominated by the page bg color — dark in dark mode, light in light mode.
 *
 * Therefore:
 *   - Dark mode → always bright/white text + dark shadows
 *   - Light mode → always dark text + light shadows
 *
 * The image's bottom+center regions provide a subtle COLOR TINT (hue/saturation)
 * so the text feels connected to the image rather than flat white/black.
 */
export function deriveHeroTextVars(
  palette: ImagePalette,
  surfaceColor?: RGB
): Record<string, string> {
  const { dominant, regions } = palette

  // Blend bottom (60%) + center (40%) — the region behind the text overlay
  const textZone: RGB = {
    r: Math.round(regions.bottom.r * 0.6 + regions.center.r * 0.4),
    g: Math.round(regions.bottom.g * 0.6 + regions.center.g * 0.4),
    b: Math.round(regions.bottom.b * 0.6 + regions.center.b * 0.4),
  }

  // Seed hero text from the extractor's surface-aware readable UI colors so
  // the text family already tracks practical surface luminance, then blend in
  // the actual text-zone tint so it still feels image-aware.
  let contrastDark = shiftTowards(textZone, palette.ui.dark.text, 0.84)
  let mutedDark = shiftTowards(contrastDark, palette.ui.dark.mutedText, 0.28)

  let contrastLight = shiftTowards(textZone, palette.ui.light.text, 0.84)
  let mutedLight = shiftTowards(contrastLight, palette.ui.light.mutedText, 0.28)

  // Determine the effective backing surface for contrast checks.
  // When the caller provides a `surfaceColor` (e.g. the computed page
  // background of the profile tab) we use that — the text is sitting on
  // the page surface, not directly on the image.  Otherwise we fall back
  // to the image's textZone for traditional hero-banner overlays.
  const contrastBg = surfaceColor ?? textZone

  // Ensure all hero text colors have sufficient contrast against the actual
  // backing surface (4.5:1 for normal text readability).
  // This prevents deep-black images from producing invisible black text labels
  // when the real background is a dark theme surface.
  contrastDark = ensureContrast(contrastDark, contrastBg, MIN_TEXT_CONTRAST)
  mutedDark = ensureContrast(mutedDark, contrastBg, MIN_TEXT_CONTRAST)
  contrastLight = ensureContrast(contrastLight, contrastBg, MIN_TEXT_CONTRAST)
  mutedLight = ensureContrast(mutedLight, contrastBg, MIN_TEXT_CONTRAST)

  // Eye-comfort clamping: dark-mode text should never be blindingly bright,
  // and light-mode text should never be a harsh smudge.
  contrastDark = constrainLuminance(contrastDark, undefined, DARK_MODE_MAX_LUM)
  mutedDark = constrainLuminance(mutedDark, undefined, DARK_MODE_MAX_LUM)
  contrastLight = constrainLuminance(contrastLight, LIGHT_MODE_MIN_LUM, undefined)
  mutedLight = constrainLuminance(mutedLight, LIGHT_MODE_MIN_LUM, undefined)

  return {
    '--hero-dominant': `rgb(${dominant.r} ${dominant.g} ${dominant.b})`,
    // Per-theme contrast (CSS selects based on data-theme-mode)
    '--hero-contrast-dark': `rgb(${contrastDark.r} ${contrastDark.g} ${contrastDark.b})`,
    '--hero-contrast-light': `rgb(${contrastLight.r} ${contrastLight.g} ${contrastLight.b})`,
    '--hero-contrast-muted-dark': `rgb(${mutedDark.r} ${mutedDark.g} ${mutedDark.b})`,
    '--hero-contrast-muted-light': `rgb(${mutedLight.r} ${mutedLight.g} ${mutedLight.b})`,
    // Dark mode: dark shadows create halo against bright image regions
    '--hero-text-glow-dark': 'rgba(0, 0, 0, 0.48)',
    // Light mode: white shadows lift dark text off dark image regions
    '--hero-text-glow-light': 'rgba(255, 255, 255, 0.65)',
    // Scrim for tag/button backgrounds
    '--hero-text-scrim-dark': 'rgba(0, 0, 0, 0.38)',
    '--hero-text-scrim-light': 'rgba(255, 255, 255, 0.40)',
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
  const hsl = pickMostVibrant(palette)

  // Dark mode: bright pastel — boosted saturation, high lightness
  const darkS = clamp(hsl.s + 10, 45, 80)
  let darkL = clamp(hsl.l, 72, 85)

  // Light mode: deep rich — boosted saturation, low lightness
  const lightS = clamp(hsl.s + 15, 50, 85)
  let lightL = clamp(hsl.l, 25, 38)

  // Guard against low-contrast edge cases (e.g. near-black palettes where
  // saturation clamping might still leave the color too dim).
  let darkRgb = ensureContrast(hslToRgb(hsl.h, darkS, darkL), REF_DARK_BG, MIN_TEXT_CONTRAST)
  // Dark mode: cap brightness so the name never glares on a dark background.
  darkRgb = constrainLuminance(darkRgb, undefined, DARK_MODE_MAX_LUM)
  darkL = rgbToHsl(darkRgb.r, darkRgb.g, darkRgb.b).l

  let lightRgb = ensureContrast(hslToRgb(hsl.h, lightS, lightL), REF_LIGHT_BG, MIN_TEXT_CONTRAST)
  // Light mode: floor brightness so the name never feels like a harsh smudge.
  lightRgb = constrainLuminance(lightRgb, LIGHT_MODE_MIN_LUM, undefined)
  lightL = rgbToHsl(lightRgb.r, lightRgb.g, lightRgb.b).l

  return {
    '--char-name-dark': `hsl(${hsl.h}, ${darkS}%, ${darkL}%)`,
    '--char-name-light': `hsl(${hsl.h}, ${lightS}%, ${lightL}%)`,
  }
}

/** Minimum saturation to consider a color "vibrant" rather than gray/muddy. */
const MIN_VIBRANT_SAT = 20

/**
 * Score palette regions by vibrancy and return the best HSL candidate.
 *
 * Vibrancy = saturation × lightness penalty × flatness penalty.
 * Flat regions (solid backgrounds like white, gray, or single-color fills)
 * have high pixel concentration in a single bucket and are heavily penalized
 * to avoid sampling the background instead of the character.
 */
function pickMostVibrant(palette: ImagePalette): { h: number; s: number; l: number } {
  const candidates: Array<{ rgb: RGB; flatness: number }> = [
    { rgb: palette.dominant, flatness: palette.flatness.full },
    { rgb: palette.regions.top, flatness: palette.flatness.top },
    { rgb: palette.regions.center, flatness: palette.flatness.center },
    { rgb: palette.regions.bottom, flatness: palette.flatness.bottom },
    { rgb: palette.regions.left, flatness: palette.flatness.left },
    { rgb: palette.regions.right, flatness: palette.flatness.right },
    { rgb: palette.average, flatness: 0 }, // average has no meaningful flatness
    ...palette.palette.map((rgb) => ({ rgb, flatness: 0 })),
  ]

  let best: { h: number; s: number; l: number } | null = null
  let bestScore = -1

  for (const { rgb, flatness } of candidates) {
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    // Penalize extreme lightness (< 15% or > 85%) — near-black/white
    const lPenalty = hsl.l < 15 ? 0.3 : hsl.l > 85 ? 0.4 : 1
    // Penalize flat/monotone regions — >50% concentration is a solid background
    // Scale: 0.0 flatness → 1.0 (no penalty), 0.5 → 0.5, 0.8 → 0.1
    const flatPenalty = flatness > 0.5 ? Math.max(0.1, 1 - flatness) : 1
    const score = hsl.s * lPenalty * flatPenalty
    if (score > bestScore) {
      bestScore = score
      best = hsl
    }
  }

  // If the best candidate is still too desaturated, force a usable color
  if (!best || best.s < MIN_VIBRANT_SAT) {
    const fallback = rgbToHsl(palette.dominant.r, palette.dominant.g, palette.dominant.b)
    return { h: fallback.h, s: Math.max(fallback.s, 45), l: 55 }
  }

  return best
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
