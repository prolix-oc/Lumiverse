/**
 * Derives a ThemeConfig accent + base-color overlay from an extracted image palette.
 *
 * The result is designed to be merged onto the user's current theme so that the
 * UI tints itself toward the active character's color palette, while preserving
 * the user's mode, glass, radius, and font preferences.
 */

import type { ImagePalette, RGB } from './colorExtraction'
import { rgbToHsl, shiftTowards } from './colorExtraction'

export interface CharacterThemeOverlay {
  accent: { h: number; s: number; l: number }
  baseColors: {
    primary?: string
    secondary?: string
    background?: string
  }
  /** Mode-aware base colors for light mode (different lightness targets). */
  baseColorsLight: {
    primary?: string
    secondary?: string
    background?: string
  }
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
  const { dominant, regions } = palette

  // Primary accent: derive from dominant
  const domHsl = rgbToHsl(dominant.r, dominant.g, dominant.b)
  // Clamp saturation to 35-70% — below 35% reads as gray, above 70% is garish
  // (especially blue/purple at high saturation). Lightness 48-65% keeps the
  // accent usable as a button/interactive color on both dark and light backgrounds.
  const accentS = clamp(domHsl.s, 35, 70)
  const accentL = clamp(domHsl.l, 48, 65)

  // Secondary: derived from the center region (the character's "core")
  const centerHsl = rgbToHsl(regions.center.r, regions.center.g, regions.center.b)
  const secondaryS = clamp(centerHsl.s, 20, 60)
  const secondaryL = clamp(centerHsl.l, 35, 55)

  // Light mode: lower lightness so colors contrast against bright backgrounds
  const accentLLight = clamp(domHsl.l, 30, 45)
  const secondaryLLight = clamp(centerHsl.l, 25, 40)

  return {
    accent: { h: domHsl.h, s: accentS, l: accentL },
    baseColors: {
      primary: `hsl(${domHsl.h}, ${accentS}%, ${accentL}%)`,
      secondary: `hsl(${centerHsl.h}, ${secondaryS}%, ${secondaryL}%)`,
    },
    baseColorsLight: {
      primary: `hsl(${domHsl.h}, ${accentS}%, ${accentLLight}%)`,
      secondary: `hsl(${centerHsl.h}, ${secondaryS}%, ${secondaryLLight}%)`,
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
  palette: ImagePalette
): Record<string, string> {
  const { dominant, regions } = palette

  // Blend bottom (60%) + center (40%) — the region behind the text overlay
  const textZone: RGB = {
    r: Math.round(regions.bottom.r * 0.6 + regions.center.r * 0.4),
    g: Math.round(regions.bottom.g * 0.6 + regions.center.g * 0.4),
    b: Math.round(regions.bottom.b * 0.6 + regions.center.b * 0.4),
  }

  // Dark mode: bright text — 92% toward white, 8% image tint
  const contrastDark = shiftTowards(textZone, { r: 250, g: 251, b: 255 }, 0.92)
  const mutedDark = shiftTowards(contrastDark, { r: 214, g: 220, b: 236 }, 0.22)

  // Light mode: dark text — 92% toward black, 8% image tint
  const contrastLight = shiftTowards(textZone, { r: 16, g: 18, b: 24 }, 0.92)
  const mutedLight = shiftTowards(contrastLight, { r: 32, g: 36, b: 46 }, 0.22)

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
  const darkL = clamp(hsl.l, 72, 85)

  // Light mode: deep rich — boosted saturation, low lightness
  const lightS = clamp(hsl.s + 15, 50, 85)
  const lightL = clamp(hsl.l, 25, 38)

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
