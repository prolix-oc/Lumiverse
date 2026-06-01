import type { ThemeConfig } from '@/types/theme'

export const PRESETS: ThemeConfig[] = [
  {
    id: 'lumiverse-purple',
    name: 'Lumiverse Purple',
    mode: 'dark',
    accent: { h: 263, s: 55, l: 65 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'midnight-blue',
    name: 'Midnight Blue',
    mode: 'dark',
    accent: { h: 220, s: 60, l: 60 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'emerald',
    name: 'Emerald',
    mode: 'dark',
    accent: { h: 152, s: 55, l: 55 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'rose',
    name: 'Rose',
    mode: 'dark',
    accent: { h: 340, s: 60, l: 65 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'amber',
    name: 'Amber',
    mode: 'dark',
    accent: { h: 38, s: 65, l: 55 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'slate',
    name: 'Slate',
    mode: 'dark',
    accent: { h: 215, s: 20, l: 55 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'lumiverse-light',
    name: 'Lumiverse Light',
    mode: 'light',
    accent: { h: 263, s: 55, l: 65 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'auto-purple',
    name: 'Auto Purple',
    mode: 'system',
    accent: { h: 263, s: 55, l: 65 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
  },
  {
    id: 'character-aware',
    name: 'Character Aware',
    mode: 'dark',
    accent: { h: 263, s: 55, l: 65 },
    radiusScale: 1,
    enableGlass: true,
    fontScale: 1,
    characterAware: true,
  },
]

export const DEFAULT_THEME = PRESETS[0]

/**
 * Backfill a persisted/imported theme against DEFAULT_THEME so required fields
 * are always present — most importantly `accent`. A theme object that lost its
 * `accent` (an older shape, a hand-edited or imported `.lumitheme` pack, or a
 * partial write) would otherwise throw `TypeError: Cannot destructure 'accent'`
 * inside `generateThemeVariables` / `ThemePanel`. Because the theme applicator
 * runs above any error boundary, that throw white-screens the whole app on load.
 *
 * Returns `null` for null/non-object input so callers fall back to DEFAULT_THEME.
 */
export function normalizeTheme(input: unknown): ThemeConfig | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null
  const t = input as Partial<ThemeConfig>
  const a = t.accent as { h?: unknown; s?: unknown; l?: unknown } | undefined
  const accentValid =
    !!a && typeof a.h === 'number' && typeof a.s === 'number' && typeof a.l === 'number'
  return {
    ...DEFAULT_THEME,
    ...t,
    accent: accentValid ? (t.accent as ThemeConfig['accent']) : DEFAULT_THEME.accent,
    radiusScale: typeof t.radiusScale === 'number' ? t.radiusScale : DEFAULT_THEME.radiusScale,
    fontScale: typeof t.fontScale === 'number' ? t.fontScale : DEFAULT_THEME.fontScale,
  }
}
