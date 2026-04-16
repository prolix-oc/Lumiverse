import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { generateThemeVariables } from '@/theme/engine'
import { DEFAULT_THEME, PRESETS } from '@/theme/presets'
import type { ResolvedMode, ThemeConfig } from '@/types/theme'

const THEME_TRANSITION_MS = 280
const COLOR_TOKEN_RE = /#[\da-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g

type Rgba = { r: number; g: number; b: number; a: number }

export function resolveMode(config: ThemeConfig): ResolvedMode {
  if (config.mode !== 'system') return config.mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyVariables(vars: Record<string, string>) {
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function parseHexColor(color: string): Rgba | null {
  const hex = color.slice(1)
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1,
    }
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: parseInt(hex[3] + hex[3], 16) / 255,
    }
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    }
  }
  return null
}

function hslToRgba(h: number, s: number, l: number, a = 1): Rgba {
  const hh = ((h % 360) + 360) % 360 / 360
  const ss = clamp(s, 0, 100) / 100
  const ll = clamp(l, 0, 100) / 100
  if (ss === 0) {
    const v = Math.round(ll * 255)
    return { r: v, g: v, b: v, a }
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }

  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  return {
    r: Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hh) * 255),
    b: Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
    a,
  }
}

function parseColorToken(token: string): Rgba | null {
  if (token.startsWith('#')) return parseHexColor(token)

  const rgbMatch = token.match(/rgba?\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)(?:\s*,\s*(-?\d*\.?\d+))?\s*\)/i)
  if (rgbMatch) {
    return {
      r: clamp(Number(rgbMatch[1]), 0, 255),
      g: clamp(Number(rgbMatch[2]), 0, 255),
      b: clamp(Number(rgbMatch[3]), 0, 255),
      a: clamp(rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]), 0, 1),
    }
  }

  const hslMatch = token.match(/hsla?\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)%\s*,\s*(-?\d*\.?\d+)%(?:\s*,\s*(-?\d*\.?\d+))?\s*\)/i)
  if (hslMatch) {
    return hslToRgba(
      Number(hslMatch[1]),
      Number(hslMatch[2]),
      Number(hslMatch[3]),
      hslMatch[4] === undefined ? 1 : clamp(Number(hslMatch[4]), 0, 1),
    )
  }

  return null
}

function interpolateToken(from: Rgba, to: Rgba, t: number): string {
  const mix = (a: number, b: number) => a + (b - a) * t
  return `rgba(${Math.round(mix(from.r, to.r))}, ${Math.round(mix(from.g, to.g))}, ${Math.round(mix(from.b, to.b))}, ${mix(from.a, to.a).toFixed(3)})`
}

function buildColorInterpolator(from: string, to: string): ((t: number) => string) | null {
  if (from === to) return null

  const fromMatches = [...from.matchAll(COLOR_TOKEN_RE)]
  const toMatches = [...to.matchAll(COLOR_TOKEN_RE)]
  if (fromMatches.length === 0 || fromMatches.length !== toMatches.length) return null

  const staticParts: string[] = []
  const fromColors: Rgba[] = []
  const toColors: Rgba[] = []
  let fromCursor = 0
  let toCursor = 0

  for (let i = 0; i < fromMatches.length; i++) {
    const fromMatch = fromMatches[i]
    const toMatch = toMatches[i]
    const fromIndex = fromMatch.index ?? 0
    const toIndex = toMatch.index ?? 0
    const fromStatic = from.slice(fromCursor, fromIndex)
    const toStatic = to.slice(toCursor, toIndex)
    if (fromStatic !== toStatic) return null

    const fromColor = parseColorToken(fromMatch[0])
    const toColor = parseColorToken(toMatch[0])
    if (!fromColor || !toColor) return null

    staticParts.push(fromStatic)
    fromColors.push(fromColor)
    toColors.push(toColor)
    fromCursor = fromIndex + fromMatch[0].length
    toCursor = toIndex + toMatch[0].length
  }

  const fromTail = from.slice(fromCursor)
  const toTail = to.slice(toCursor)
  if (fromTail !== toTail) return null
  staticParts.push(fromTail)

  return (t: number) => {
    let result = ''
    for (let i = 0; i < fromColors.length; i++) {
      result += staticParts[i]
      result += interpolateToken(fromColors[i], toColors[i], t)
    }
    result += staticParts[staticParts.length - 1]
    return result
  }
}

/** Threshold: if an extension override provides this many variables, it IS the theme. */
const FULL_THEME_MIN_KEYS = 40

function buildResolvedThemeVars(
  theme: ThemeConfig | null,
  extensionThemeOverrides: ReturnType<typeof useStore.getState>['extensionThemeOverrides'],
  modeOverride?: ResolvedMode,
): { config: ThemeConfig; mode: ResolvedMode; vars: Record<string, string>; hasOverrides: boolean } {
  const config = theme ?? DEFAULT_THEME
  const hasOverrides = Object.keys(extensionThemeOverrides).length > 0
  const mode = modeOverride ?? resolveMode(config)

  // Check if any extension provides a full theme-sized override (e.g. via
  // applyPalette). Even then, still layer it on top of the user's resolved
  // theme so omitted preference-owned tokens (glass blur, radii, fonts,
  // scaling) keep their current values instead of falling back to CSS
  // defaults.
  let fullThemeVars: Record<string, string> | null = null
  for (const override of Object.values(extensionThemeOverrides)) {
    if (override.paletteAccent) continue

    const modeVars = override.variablesByMode?.[mode]
    if (modeVars && Object.keys(modeVars).length >= FULL_THEME_MIN_KEYS) {
      fullThemeVars = { ...modeVars, ...override.variables }
    } else if (Object.keys(override.variables).length >= FULL_THEME_MIN_KEYS) {
      fullThemeVars = { ...override.variables }
      if (modeVars) Object.assign(fullThemeVars, modeVars)
    }
  }

  const baseVars = generateThemeVariables(config, mode)

  if (fullThemeVars) {
    return {
      config,
      mode,
      vars: {
        ...baseVars,
        ...fullThemeVars,
      },
      hasOverrides: true,
    }
  }

  // Partial overrides: generate the user's base theme, then layer on the
  // extension's handful of tweaks.
  const vars = baseVars
  for (const override of Object.values(extensionThemeOverrides)) {
    if (override.paletteAccent) {
      Object.assign(vars, generateThemeVariables({ ...config, accent: override.paletteAccent }, mode))
    }

    for (const [key, value] of Object.entries(override.variables)) {
      vars[key] = value
    }
    const modeVars = override.variablesByMode?.[mode]
    if (modeVars) {
      for (const [key, value] of Object.entries(modeVars)) {
        vars[key] = value
      }
    }
  }

  return { config, mode, vars, hasOverrides }
}

export function useThemeApplicator() {
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const extensionThemeOverrides = useStore((s) => s.extensionThemeOverrides)
  const prevKeysRef = useRef<string[]>([])
  const appliedVarsRef = useRef<Record<string, string> | null>(null)
  const hadOverridesRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)')

    const applyResolvedTheme = (modeOverride?: ResolvedMode) => {
      const { config, mode, vars, hasOverrides } = buildResolvedThemeVars(theme, extensionThemeOverrides, modeOverride)
      const nextKeys = Object.keys(vars)

      for (const key of prevKeysRef.current) {
        if (!(key in vars)) {
          root.style.removeProperty(key)
        }
      }
      prevKeysRef.current = nextKeys

      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }

      const previousVars = appliedVarsRef.current
      const shouldAnimate =
        !motionMq.matches &&
        previousVars !== null &&
        (hasOverrides || hadOverridesRef.current)

      root.setAttribute('data-theme-mode', mode)

      if (shouldAnimate && previousVars) {
        const animatedEntries = Object.entries(vars)
          .map(([key, value]) => {
            const previousValue = previousVars[key]
            if (!previousValue) return null
            const interpolate = buildColorInterpolator(previousValue, value)
            return interpolate ? [key, interpolate] as const : null
          })
          .filter((entry): entry is readonly [string, (t: number) => string] => entry !== null)

        if (animatedEntries.length > 0) {
          const animatedKeys = new Set(animatedEntries.map(([key]) => key))
          const immediateVars: Record<string, string> = {}
          for (const [key, value] of Object.entries(vars)) {
            if (!animatedKeys.has(key)) immediateVars[key] = value
          }
          applyVariables(immediateVars)

          const start = performance.now()
          const step = (now: number) => {
            const t = clamp((now - start) / THEME_TRANSITION_MS, 0, 1)
            const eased = 1 - Math.pow(1 - t, 3)
            const frameVars: Record<string, string> = {}
            for (const [key, interpolate] of animatedEntries) {
              frameVars[key] = interpolate(eased)
            }
            applyVariables(frameVars)
            appliedVarsRef.current = { ...immediateVars, ...frameVars }

            if (t < 1) {
              animationFrameRef.current = requestAnimationFrame(step)
              return
            }

            applyVariables(vars)
            appliedVarsRef.current = vars
            animationFrameRef.current = null
          }

          animationFrameRef.current = requestAnimationFrame(step)
        } else {
          applyVariables(vars)
          appliedVarsRef.current = vars
        }
      } else {
        applyVariables(vars)
        appliedVarsRef.current = vars
      }

      hadOverridesRef.current = hasOverrides

      if (!root.hasAttribute('data-pwa')) {
        const us = parseFloat(vars['--lumiverse-ui-scale'] ?? '1') || 1
        const vh = window.visualViewport?.height ?? window.innerHeight
        root.style.setProperty('--app-shell-height', `${Math.round(vh / us)}px`)
      }
      window.dispatchEvent(new Event('resize'))

      if (config.enableGlass && !motionMq.matches) {
        root.setAttribute('data-glass', '')
      } else {
        root.removeAttribute('data-glass')
      }

      return { config }
    }

    const initial = applyResolvedTheme()
    const config = initial?.config ?? (theme ?? DEFAULT_THEME)

    const updateGlass = () => {
      const latest = buildResolvedThemeVars(theme, extensionThemeOverrides)
      if (latest.config.enableGlass && !motionMq.matches) {
        root.setAttribute('data-glass', '')
      } else {
        root.removeAttribute('data-glass')
      }
    }
    motionMq.addEventListener('change', updateGlass)

    if (config.mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => {
        const newMode: ResolvedMode = mq.matches ? 'dark' : 'light'
        applyResolvedTheme(newMode)
        updateGlass()
      }
      mq.addEventListener('change', handler)
      return () => {
        mq.removeEventListener('change', handler)
        motionMq.removeEventListener('change', updateGlass)
      }
    }

    return () => {
      motionMq.removeEventListener('change', updateGlass)
    }
  }, [theme, extensionThemeOverrides])
}
