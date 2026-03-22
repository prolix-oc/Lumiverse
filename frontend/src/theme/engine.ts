import type { ThemeConfig, ResolvedMode } from '@/types/theme'

// ── Color helpers ──

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function hsla(h: number, s: number, l: number, a: number = 1): string {
  return `hsla(${Math.round(h)}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%, ${a})`
}

function rgba(r: number, g: number, b: number, a: number = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Parse a hex color (#rrggbb or #rgb) to [r, g, b] (0-255). */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace('#', '')
  if (m.length === 3) {
    return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)]
  }
  if (m.length === 6) {
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
  }
  return null
}

/** Generate a tinted rgba from a hex color at the given alpha. */
function hexRgba(hex: string, a: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return `rgba(128, 128, 128, ${a})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`
}

/** Lighten or darken a hex color by a factor (-1 to 1). */
function adjustHex(hex: string, factor: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const adjust = (c: number) => Math.round(clamp(c + factor * 255, 0, 255))
  const r = adjust(rgb[0])
  const g = adjust(rgb[1])
  const b = adjust(rgb[2])
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

// ── Main generator ──

export function generateThemeVariables(
  config: ThemeConfig,
  mode: ResolvedMode
): Record<string, string> {
  const { h, s, l } = config.accent
  const rs = config.radiusScale
  const glass = config.enableGlass
  const fs = config.fontScale

  const isDark = mode === 'dark'

  // Derived saturation for backgrounds (low-chroma tint)
  const bgSat = s * 0.3
  // Derived saturation for text in light mode
  const textSat = s * 0.2

  const vars: Record<string, string> = {}

  // ── Primary accent ──
  const pL = isDark ? l : l - 20
  vars['--lumiverse-primary'] = hsla(h, s, pL, 0.9)
  vars['--lumiverse-primary-hover'] = hsla(h, s, pL + 7, 0.95)
  vars['--lumiverse-primary-light'] = hsla(h, s, pL, 0.1)
  vars['--lumiverse-primary-muted'] = hsla(h, s, pL, 0.6)
  vars['--lumiverse-primary-text'] = hsla(h, s + 5, pL + 11, 0.95)
  vars['--lumiverse-primary-010'] = hsla(h, s, pL, 0.1)
  vars['--lumiverse-primary-015'] = hsla(h, s, pL, 0.15)
  vars['--lumiverse-primary-020'] = hsla(h, s, pL, 0.2)
  vars['--lumiverse-primary-050'] = hsla(h, s, pL, 0.5)

  // ── Secondary (neutral gray) ──
  vars['--lumiverse-secondary'] = rgba(128, 128, 128, 0.15)
  vars['--lumiverse-secondary-hover'] = rgba(128, 128, 128, 0.25)
  vars['--lumiverse-secondary-border'] = rgba(128, 128, 128, 0.25)

  // ── Status colors ──
  const danger = config.statusColors?.danger ?? '#ef4444'
  const success = config.statusColors?.success ?? '#22c55e'
  const warning = config.statusColors?.warning ?? '#f59e0b'
  vars['--lumiverse-danger'] = danger
  vars['--lumiverse-danger-hover'] = '#dc2626'
  vars['--lumiverse-danger-015'] = rgba(239, 68, 68, 0.15)
  vars['--lumiverse-danger-020'] = rgba(239, 68, 68, 0.2)
  vars['--lumiverse-danger-050'] = rgba(239, 68, 68, 0.5)
  vars['--lumiverse-success'] = success
  vars['--lumiverse-warning'] = warning

  // ── Backgrounds ──
  if (isDark) {
    // Dark mode: low-sat, low-L backgrounds with accent tint
    vars['--lumiverse-bg'] = hsla(h, bgSat, 12, 0.95)
    vars['--lumiverse-bg-elevated'] = hsla(h, bgSat, 15, 0.9)
    vars['--lumiverse-bg-hover'] = hsla(h, bgSat, 19, 0.9)
    vars['--lumiverse-bg-dark'] = rgba(0, 0, 0, 0.15)
    vars['--lumiverse-bg-darker'] = rgba(0, 0, 0, 0.25)
    vars['--lumiverse-bg-040'] = hsla(h, bgSat, 12, 0.4)
    vars['--lumiverse-bg-050'] = hsla(h, bgSat, 12, 0.5)
    vars['--lumiverse-bg-070'] = hsla(h, bgSat, 12, 0.7)
    vars['--lumiverse-bg-elevated-040'] = hsla(h, bgSat, 15, 0.4)
    vars['--lumiverse-bg-deep-080'] = hsla(h, bgSat, 9, 0.8)
    vars['--lumiverse-bg-deep'] = hsla(h, bgSat, 5, 1)
    vars['--lumiverse-scene-text-scrim'] = hsla(h, bgSat, 4, 0.48)
  } else {
    // Light mode: high-L backgrounds, subtle accent tint
    const lbgSat = s * 0.15
    vars['--lumiverse-bg'] = hsla(h, lbgSat, 96, 1)
    vars['--lumiverse-bg-elevated'] = hsla(h, lbgSat, 100, 1)
    vars['--lumiverse-bg-hover'] = hsla(h, lbgSat, 93, 1)
    vars['--lumiverse-bg-dark'] = rgba(0, 0, 0, 0.04)
    vars['--lumiverse-bg-darker'] = rgba(0, 0, 0, 0.07)
    vars['--lumiverse-bg-040'] = hsla(h, lbgSat, 96, 0.4)
    vars['--lumiverse-bg-050'] = hsla(h, lbgSat, 96, 0.5)
    vars['--lumiverse-bg-070'] = hsla(h, lbgSat, 96, 0.7)
    vars['--lumiverse-bg-elevated-040'] = hsla(h, lbgSat, 100, 0.4)
    vars['--lumiverse-bg-deep-080'] = hsla(h, lbgSat, 92, 0.8)
    vars['--lumiverse-bg-deep'] = hsla(h, lbgSat, 90, 1)
    vars['--lumiverse-scene-text-scrim'] = hsla(h, lbgSat, 98, 0.56)
  }

  // ── Borders ──
  vars['--lumiverse-border'] = hsla(h, s, pL, isDark ? 0.12 : 0.15)
  vars['--lumiverse-border-hover'] = hsla(h, s, pL, isDark ? 0.25 : 0.3)
  vars['--lumiverse-border-light'] = rgba(128, 128, 128, isDark ? 0.12 : 0.15)
  vars['--lumiverse-border-neutral'] = rgba(128, 128, 128, isDark ? 0.15 : 0.18)
  vars['--lumiverse-border-neutral-hover'] = rgba(128, 128, 128, isDark ? 0.25 : 0.3)

  // ── Text ──
  if (isDark) {
    vars['--lumiverse-text'] = rgba(255, 255, 255, 0.9)
    vars['--lumiverse-text-muted'] = rgba(255, 255, 255, 0.65)
    vars['--lumiverse-text-dim'] = rgba(255, 255, 255, 0.4)
    vars['--lumiverse-text-hint'] = rgba(255, 255, 255, 0.3)
  } else {
    vars['--lumiverse-text'] = hsla(h, textSat, 10, 0.9)
    vars['--lumiverse-text-muted'] = hsla(h, textSat, 10, 0.6)
    vars['--lumiverse-text-dim'] = hsla(h, textSat, 10, 0.4)
    vars['--lumiverse-text-hint'] = hsla(h, textSat, 10, 0.3)
  }

  // ── Border radii ──
  const baseRadii = [5, 8, 10, 12, 16]
  const radiiNames = ['sm', '', 'md', 'lg', 'xl']
  radiiNames.forEach((name, i) => {
    const key = name ? `--lumiverse-radius-${name}` : '--lumiverse-radius'
    vars[key] = `${Math.round(baseRadii[i] * rs)}px`
  })

  // ── Shadows ──
  const shadowAlpha = isDark ? 1 : 0.4
  vars['--lumiverse-shadow'] = `0 4px 6px -1px ${rgba(0, 0, 0, 0.3 * shadowAlpha)}`
  vars['--lumiverse-shadow-sm'] = `0 2px 8px ${rgba(0, 0, 0, 0.2 * shadowAlpha)}`
  vars['--lumiverse-shadow-md'] = `0 8px 24px ${rgba(0, 0, 0, 0.4 * shadowAlpha)}`
  vars['--lumiverse-shadow-lg'] = `0 24px 80px ${rgba(0, 0, 0, 0.5 * shadowAlpha)}, 0 0 1px ${hsla(h, s, pL, 0.3 * shadowAlpha)}`
  vars['--lumiverse-shadow-xl'] = `0 20px 60px ${rgba(0, 0, 0, 0.5 * shadowAlpha)}`

  // ── Highlight insets ──
  const hiAlpha = isDark ? 1 : 0.5
  vars['--lumiverse-highlight-inset'] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.1 * hiAlpha)}`
  vars['--lumiverse-highlight-inset-md'] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.2 * hiAlpha)}`
  vars['--lumiverse-highlight-inset-lg'] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.25 * hiAlpha)}`

  // ── Modal & overlays ──
  vars['--lumiverse-modal-backdrop'] = rgba(0, 0, 0, isDark ? 0.6 : 0.3)
  vars['--lumiverse-swatch-border'] = rgba(255, 255, 255, isDark ? 0.15 : 0.3)
  if (isDark) {
    vars['--lumiverse-gradient-modal'] = `linear-gradient(135deg, ${hsla(h, bgSat, 15, 0.98)}, ${hsla(h, bgSat, 9, 0.98)})`
  } else {
    vars['--lumiverse-gradient-modal'] = `linear-gradient(135deg, ${hsla(h, s * 0.15, 98, 0.98)}, ${hsla(h, s * 0.15, 95, 0.98)})`
  }

  // ── Icon colors (mirrors text) ──
  vars['--lumiverse-icon'] = vars['--lumiverse-text']
  vars['--lumiverse-icon-muted'] = isDark ? rgba(255, 255, 255, 0.6) : hsla(h, textSat, 10, 0.55)
  vars['--lumiverse-icon-dim'] = vars['--lumiverse-text-dim']

  // ── Fill colors ──
  const fillBase = isDark ? 1 : 0.4
  vars['--lumiverse-fill-subtle'] = rgba(0, 0, 0, 0.1 * fillBase)
  vars['--lumiverse-fill'] = rgba(0, 0, 0, 0.15 * fillBase)
  vars['--lumiverse-fill-hover'] = rgba(0, 0, 0, 0.2 * fillBase)
  vars['--lumiverse-fill-medium'] = rgba(0, 0, 0, 0.25 * fillBase)
  vars['--lumiverse-fill-strong'] = rgba(0, 0, 0, 0.3 * fillBase)
  vars['--lumiverse-fill-heavy'] = rgba(0, 0, 0, 0.5 * fillBase)
  vars['--lumiverse-fill-deepest'] = rgba(0, 0, 0, 0.7 * fillBase)

  // ── Card backgrounds ──
  if (isDark) {
    vars['--lumiverse-card-bg'] = `linear-gradient(165deg, ${hsla(h, bgSat, 12, 0.95)} 0%, ${hsla(h, bgSat, 10, 0.9)} 50%, ${hsla(h, bgSat, 8, 0.95)} 100%)`
    vars['--lumiverse-card-image-bg'] = `linear-gradient(135deg, ${hsla(h, bgSat, 9, 0.8)} 0%, ${hsla(h, bgSat, 13, 0.6)} 100%)`
  } else {
    vars['--lumiverse-card-bg'] = `linear-gradient(165deg, ${hsla(h, s * 0.15, 99, 1)} 0%, ${hsla(h, s * 0.15, 97, 1)} 50%, ${hsla(h, s * 0.15, 95, 1)} 100%)`
    vars['--lumiverse-card-image-bg'] = `linear-gradient(135deg, ${hsla(h, s * 0.15, 95, 0.8)} 0%, ${hsla(h, s * 0.15, 97, 0.6)} 100%)`
  }

  // ── Transitions (not theme-dependent, but included for completeness) ──
  vars['--lumiverse-transition'] = '200ms ease'
  vars['--lumiverse-transition-fast'] = '150ms ease'

  // ── Typography ──
  vars['--lumiverse-font-family'] = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
  vars['--lumiverse-font-mono'] = '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'

  // Font scale: always set so UI updates immediately in both directions.
  vars['--lumiverse-font-scale'] = `${fs}`

  // ── Chat Sheld glass tokens ──
  if (isDark) {
    vars['--lcs-glass-bg'] = glass ? hsla(h, bgSat, 6, 0.55) : hsla(h, bgSat, 10, 0.97)
    vars['--lcs-glass-bg-hover'] = glass ? hsla(h, bgSat, 9, 0.65) : hsla(h, bgSat, 14, 0.99)
    vars['--lcs-glass-border'] = rgba(255, 255, 255, glass ? 0.06 : 0.05)
    vars['--lcs-glass-border-hover'] = rgba(255, 255, 255, glass ? 0.1 : 0.08)
    vars['--lcs-glass-blur'] = glass ? '14px' : '0px'
    vars['--lcs-glass-soft-blur'] = glass ? '8px' : '0px'
    vars['--lcs-glass-strong-blur'] = glass ? '40px' : '0px'
  } else {
    vars['--lcs-glass-bg'] = glass ? hsla(h, s * 0.15, 98, 0.6) : hsla(h, s * 0.15, 97, 0.98)
    vars['--lcs-glass-bg-hover'] = glass ? hsla(h, s * 0.15, 100, 0.72) : hsla(h, s * 0.15, 99, 1)
    vars['--lcs-glass-border'] = rgba(0, 0, 0, glass ? 0.06 : 0.09)
    vars['--lcs-glass-border-hover'] = rgba(0, 0, 0, glass ? 0.08 : 0.12)
    vars['--lcs-glass-blur'] = glass ? '14px' : '0px'
    vars['--lcs-glass-soft-blur'] = glass ? '8px' : '0px'
    vars['--lcs-glass-strong-blur'] = glass ? '40px' : '0px'
  }
  vars['--lcs-radius'] = `${Math.round(14 * rs)}px`
  vars['--lcs-radius-sm'] = `${Math.round(8 * rs)}px`
  vars['--lcs-radius-xs'] = `${Math.round(5 * rs)}px`
  vars['--lcs-transition'] = '220ms cubic-bezier(0.4, 0, 0.2, 1)'
  vars['--lcs-transition-fast'] = '120ms cubic-bezier(0.4, 0, 0.2, 1)'

  // ── Prose tokens ──
  if (isDark) {
    vars['--lumiverse-prose-italic'] = 'var(--lumiverse-text-muted)'
  } else {
    vars['--lumiverse-prose-italic'] = 'var(--lumiverse-text-muted)'
  }
  vars['--lumiverse-prose-bold'] = 'inherit'
  vars['--lumiverse-prose-dialogue'] = 'var(--lumiverse-primary-text)'
  vars['--lumiverse-prose-blockquote'] = 'var(--lumiverse-text-muted)'
  vars['--lumiverse-prose-link'] = hsla(h, s + 10, pL + 15, 0.9)

  // ── Base color overrides (mode-aware, falls back to legacy baseColors) ──
  const bc = config.baseColorsByMode?.[mode] ?? config.baseColors
  if (bc) {
    if (bc.primary) {
      vars['--lumiverse-primary'] = bc.primary
      vars['--lumiverse-primary-hover'] = adjustHex(bc.primary, 0.08)
      vars['--lumiverse-primary-light'] = hexRgba(bc.primary, 0.1)
      vars['--lumiverse-primary-muted'] = hexRgba(bc.primary, 0.6)
      vars['--lumiverse-primary-text'] = adjustHex(bc.primary, 0.12)
      vars['--lumiverse-primary-010'] = hexRgba(bc.primary, 0.1)
      vars['--lumiverse-primary-015'] = hexRgba(bc.primary, 0.15)
      vars['--lumiverse-primary-020'] = hexRgba(bc.primary, 0.2)
      vars['--lumiverse-primary-050'] = hexRgba(bc.primary, 0.5)
    }
    if (bc.secondary) {
      vars['--lumiverse-secondary'] = hexRgba(bc.secondary, 0.15)
      vars['--lumiverse-secondary-hover'] = hexRgba(bc.secondary, 0.25)
      vars['--lumiverse-secondary-border'] = hexRgba(bc.secondary, 0.25)
    }
    if (bc.background) {
      vars['--lumiverse-bg'] = bc.background
      vars['--lumiverse-bg-elevated'] = adjustHex(bc.background, 0.04)
      vars['--lumiverse-bg-hover'] = adjustHex(bc.background, 0.06)
      vars['--lumiverse-bg-deep'] = adjustHex(bc.background, -0.05)
    }
    if (bc.text) {
      vars['--lumiverse-text'] = bc.text
      vars['--lumiverse-text-muted'] = hexRgba(bc.text, 0.65)
      vars['--lumiverse-text-dim'] = hexRgba(bc.text, 0.4)
      vars['--lumiverse-text-hint'] = hexRgba(bc.text, 0.3)
    }
    if (bc.danger) {
      vars['--lumiverse-danger'] = bc.danger
      vars['--lumiverse-danger-hover'] = adjustHex(bc.danger, -0.06)
      vars['--lumiverse-danger-015'] = hexRgba(bc.danger, 0.15)
      vars['--lumiverse-danger-020'] = hexRgba(bc.danger, 0.2)
      vars['--lumiverse-danger-050'] = hexRgba(bc.danger, 0.5)
    }
    if (bc.success) vars['--lumiverse-success'] = bc.success
    if (bc.warning) vars['--lumiverse-warning'] = bc.warning
    if (bc.speech) vars['--lumiverse-prose-dialogue'] = bc.speech
    if (bc.thoughts) vars['--lumiverse-prose-italic'] = bc.thoughts
  }

  return vars
}
