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
  // Ensure accent is vibrant enough to read as a theme color
  const accentS = Math.max(domHsl.s, 35)
  const accentL = clamp(domHsl.l, 40, 70)

  // Secondary: derived from the center region (the character's "core")
  const centerHsl = rgbToHsl(regions.center.r, regions.center.g, regions.center.b)
  const secondaryS = Math.max(centerHsl.s, 20)
  const secondaryL = clamp(centerHsl.l, 30, 60)

  return {
    accent: { h: domHsl.h, s: accentS, l: accentL },
    baseColors: {
      primary: `hsl(${domHsl.h}, ${accentS}%, ${accentL}%)`,
      secondary: `hsl(${centerHsl.h}, ${secondaryS}%, ${secondaryL}%)`,
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
 * the character's dominant hue — bright pastel in dark mode, deep saturated in light.
 */
export function deriveCharacterNameVars(
  palette: ImagePalette
): Record<string, string> {
  const { dominant } = palette
  const hsl = rgbToHsl(dominant.r, dominant.g, dominant.b)

  // Dark mode: bright pastel — boosted saturation, high lightness
  const darkS = clamp(hsl.s + 10, 40, 75)
  const darkL = clamp(hsl.l, 70, 85)

  // Light mode: deep rich — boosted saturation, low lightness
  const lightS = clamp(hsl.s + 15, 45, 80)
  const lightL = clamp(hsl.l, 25, 40)

  return {
    '--char-name-dark': `hsl(${hsl.h}, ${darkS}%, ${darkL}%)`,
    '--char-name-light': `hsl(${hsl.h}, ${lightS}%, ${lightL}%)`,
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
