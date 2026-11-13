export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedMode = 'light' | 'dark'
export type RenderingMode = 'efficiency' | 'balanced' | 'quality'

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

export type BaseColors = Partial<Record<BaseColorKey, string>> & {
  /** Internal deep/root surface override; not exposed as a user-facing base color. */
  backgroundDeep?: string
}

export interface CharacterThemeOverlay {
  accent: { h: number; s: number; l: number }
  baseColors: {
    primary?: string
    secondary?: string
    background?: string
    backgroundDeep?: string
    text?: string
  }
  baseColorsLight: {
    primary?: string
    secondary?: string
    background?: string
    backgroundDeep?: string
    text?: string
  }
}

/** Native-wrapper-only surface for a translucent document background. */
export interface DesktopBackground {
  /** Any valid CSS color, typically with an alpha channel (for example `rgb(16 12 28 / 72%)`). */
  color: string
  /** Request native material blur where the platform supports it. */
  blur?: boolean
  /** Semantic native material level. Native APIs do not expose a pixel blur radius. */
  blurIntensity?: 'subtle' | 'balanced' | 'strong'
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
  /**
   * Opt-in "liquid glass" material. Refracts and blurs what sits behind
   * surfaces with an SVG displacement filter instead of the flat frosted
   * `enableGlass` layer. Ignored when `enableGlass` is off or the renderer is
   * in efficiency mode, so it can never outlive the blur it depends on.
   */
  liquidGlass?: boolean
  fontScale: number
  /** CSS zoom applied to the body element for full UI scaling (0.5–1.5). */
  uiScale?: number
  /** When true, accent and primary colors are dynamically derived from the active character's avatar. */
  characterAware?: boolean
  /** Optional tint for the Tauri frontend body; ignored in browsers and PWAs. */
  desktopBackground?: DesktopBackground
  /** Native WebView graphics policy. Quality enables high-refresh rendering on supported macOS displays. */
  renderingMode?: RenderingMode
}
