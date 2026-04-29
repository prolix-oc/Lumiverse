export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedMode = 'light' | 'dark'

export type BaseColorKey =
  | 'primary'
  | 'secondary'
  | 'background'
  | 'text'
  | 'danger'
  | 'success'
  | 'warning'
  | 'speech'
  | 'thoughts'

export type BaseColors = Partial<Record<BaseColorKey, string>>

export interface CharacterThemeOverlay {
  accent: { h: number; s: number; l: number }
  baseColors: {
    primary?: string
    secondary?: string
    background?: string
    text?: string
  }
  baseColorsLight: {
    primary?: string
    secondary?: string
    background?: string
    text?: string
  }
}

export interface ThemeConfig {
  id: string
  name: string
  mode: ThemeMode
  accent: { h: number; s: number; l: number }
  statusColors?: { danger?: string; success?: string; warning?: string }
  /** @deprecated Use baseColorsByMode for mode-aware overrides. Kept as fallback for existing configs. */
  baseColors?: BaseColors
  /** Per-mode base color overrides. Priority over legacy baseColors. */
  baseColorsByMode?: { dark?: BaseColors; light?: BaseColors }
  radiusScale: number
  enableGlass: boolean
  fontScale: number
  /** CSS zoom applied to the body element for full UI scaling (0.8–1.5). */
  uiScale?: number
  /** When true, accent and primary colors are dynamically derived from the active character's avatar. */
  characterAware?: boolean
}
