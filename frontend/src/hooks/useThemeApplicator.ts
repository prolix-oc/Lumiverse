import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import { activeDeviceThemeControls, resolveDeviceTheme, useDeviceThemeControls, type ThemeControls } from '@/lib/deviceThemeControls'
import { generateThemeVariables } from '@/theme/engine'
import { DEFAULT_THEME, PRESETS } from '@/theme/presets'
import { isOpaqueThemeColor, toOpaqueRgb, toOpaqueRgbChannels, withPreservedAlpha } from '@/theme/themeColor'
import { isLiquidGlassActive } from '@/lib/liquidGlass'
import type { CharacterThemeOverlay, ResolvedMode, ThemeConfig } from '@/types/theme'

const THEME_TRANSITION_MS = 280
const COLOR_TOKEN_RE = /#[\da-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g
const DESKTOP_APPEARANCE_DEBUG_KEY = 'lumiverse.desktopAppearanceDebug'
const DESKTOP_APPEARANCE_DEBUG_HISTORY_KEY = '__lumiverseDesktopAppearanceDebug'

// Changing an accent or extension palette re-applies the complete CSS theme,
// but it must not recreate the native vibrancy/Mica effect. Recreating that
// effect forces WebKit to rebuild its backing surface and can briefly drop the
// desktop backdrop. Keep the last requested native appearance separate from
// the document tint, which is safe to update on every theme application.
let requestedNativeAppearance: string | null = null
let nativeAppearanceQueue: Promise<void> = Promise.resolve()
let cachedStartupAppearance: string | null = null

/**
 * Opt-in trace for diagnosing desktop material failures. Enable it from the
 * web inspector with `localStorage.setItem('lumiverse.desktopAppearanceDebug',
 * '1')`, then reload. The snapshots let us tell a theme state reset apart
 * from WKWebView losing an otherwise-correct backdrop compositing layer.
 */
function debugDesktopAppearance(event: string, details: Record<string, unknown> = {}) {
  try {
    if (localStorage.getItem(DESKTOP_APPEARANCE_DEBUG_KEY) !== '1') return

    window.requestAnimationFrame(() => {
      const root = document.documentElement
      const app = document.querySelector<HTMLElement>('[data-app-root]')
      const titlebar = document.querySelector<HTMLElement>('[data-lumiverse-titlebar]')
      const appStyle = app ? getComputedStyle(app) : null
      const titlebarStyle = titlebar ? getComputedStyle(titlebar.parentElement as Element) : null
      const entry = {
        event,
        at: new Date().toISOString(),
        requestedNativeAppearance,
        desktopBackground: root.getAttribute('data-desktop-background'),
        desktopBlur: root.getAttribute('data-desktop-background-blur'),
        tint: root.style.getPropertyValue('--lumiverse-desktop-background'),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        appBackground: appStyle?.backgroundColor ?? null,
        appBackdropFilter: appStyle?.backdropFilter ?? null,
        titlebarPresent: Boolean(titlebar),
        titlebarDisplay: titlebarStyle?.display ?? null,
        titlebarVisibility: titlebarStyle?.visibility ?? null,
        titlebarOpacity: titlebarStyle?.opacity ?? null,
        titlebarZIndex: titlebarStyle?.zIndex ?? null,
        webGlass: root.hasAttribute('data-glass'),
        ...details,
      }
      const debugWindow = window as Window & {
        [DESKTOP_APPEARANCE_DEBUG_HISTORY_KEY]?: typeof entry[]
      }
      const history = debugWindow[DESKTOP_APPEARANCE_DEBUG_HISTORY_KEY] ?? []
      history.push(entry)
      if (history.length > 100) history.shift()
      debugWindow[DESKTOP_APPEARANCE_DEBUG_HISTORY_KEY] = history

      console.info('[desktop-appearance]', entry)
    })
  } catch {
    // Diagnostics must never interfere with rendering or theme application.
  }
}

type Rgba = { r: number; g: number; b: number; a: number }

export function resolveMode(config: ThemeConfig): ResolvedMode {
  if (config.mode !== 'system') return config.mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Publish the resolved glass state on the root element. Components and global
 * CSS key off these attributes instead of re-deriving the rules, so the
 * frosted layer (`data-glass`) and the liquid layer (`data-liquid-glass`) can
 * never drift out of sync with the theme config.
 */
export function applyGlassAttributes(
  config: ThemeConfig,
  prefersReducedMotion: boolean,
): void {
  const root = document.documentElement
  const glassOn = config.enableGlass && config.renderingMode !== 'efficiency' && !prefersReducedMotion

  if (glassOn) {
    root.setAttribute('data-glass', '')
  } else {
    root.removeAttribute('data-glass')
  }

  if (isLiquidGlassActive(config, prefersReducedMotion)) {
    root.setAttribute('data-liquid-glass', '')
  } else {
    root.removeAttribute('data-liquid-glass')
  }
}

function applyVariables(vars: Record<string, string>) {
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}

function broadcastThemeToParent(mode: ResolvedMode, vars: Record<string, string>) {
  if (window.parent === window) return
  try {
    window.parent.postMessage(
      {
        __lumiverseTheme: true,
        mode,
        vars: {
          '--lumiverse-bg-deep': vars['--lumiverse-bg-deep'] ?? '',
          '--lumiverse-primary': vars['--lumiverse-primary'] ?? '',
          '--lumiverse-primary-020': vars['--lumiverse-primary-020'] ?? '',
          '--lumiverse-border': vars['--lumiverse-border'] ?? '',
          '--lumiverse-text-muted': vars['--lumiverse-text-muted'] ?? '',
        },
      },
      '*',
    )
  } catch {
    /* parent unreachable — ignore */
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

function syncThemeColorMeta(vars: Record<string, string>) {
  const color =
    toOpaqueRgb(vars['--lumiverse-bg-deep'] ?? '') ??
    toOpaqueRgb(vars['--lumiverse-bg'] ?? '') ??
    '#0a0812'

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = color
}

export function resolveDesktopSurfaceColor(
  config: ThemeConfig,
  vars: Record<string, string>,
  hasPaletteOverride: boolean,
): string {
  const configuredBackground = config.desktopBackground?.color
  if (!configuredBackground) return vars['--lumiverse-bg-deep'] || '#0a0812'

  // A palette supplies a complete, mode-aware background family. Preserve the
  // user's configured translucency while replacing only the tint color.
  if (hasPaletteOverride && vars['--lumiverse-bg-deep']) {
    return withPreservedAlpha(vars['--lumiverse-bg-deep'], configuredBackground) ?? configuredBackground
  }
  return configuredBackground
}

export type DesktopSurfaceMode = 'opaque' | 'translucent'

export function resolveDesktopSurface(
  config: ThemeConfig,
  vars: Record<string, string>,
  hasPaletteOverride: boolean,
) {
  const configured = resolveDesktopSurfaceColor(config, vars, hasPaletteOverride)
  const efficiency = config.renderingMode === 'efficiency'
  const background = efficiency ? (toOpaqueRgb(configured) ?? 'rgb(10, 8, 18)') : configured
  const surfaceMode: DesktopSurfaceMode = efficiency || isOpaqueThemeColor(background) ? 'opaque' : 'translucent'
  return {
    background,
    surfaceMode,
    blur: surfaceMode === 'translucent' && Boolean(config.desktopBackground?.color && config.desktopBackground.blur),
    nativeColor: toOpaqueRgbChannels(background) ?? [10, 8, 18],
  }
}

function cacheDesktopStartupAppearance(
  config: ThemeConfig,
  mode: ResolvedMode,
  vars: Record<string, string>,
  hasPaletteOverride: boolean,
) {
  if (!hasTauriDesktopBridge() || new URLSearchParams(window.location.search).has('desktopWidgetExtension')) return

  const surface = resolveDesktopSurface(config, vars, hasPaletteOverride)
  const snapshot = {
    background: surface.background,
    surfaceMode: surface.surfaceMode,
    border: vars['--lumiverse-border'] || 'rgba(255, 255, 255, 0.08)',
    textMuted: vars['--lumiverse-text-muted'] || 'rgba(255, 255, 255, 0.64)',
    primary: vars['--lumiverse-primary'] || '#9370db',
    blur: surface.blur,
    dark: mode === 'dark',
    blurIntensity: config.desktopBackground?.blurIntensity ?? 'balanced',
    nativeColor: surface.nativeColor,
    highRefresh: config.renderingMode === 'quality',
  }
  const serialized = JSON.stringify(snapshot)
  if (serialized === cachedStartupAppearance) return
  cachedStartupAppearance = serialized
  void invoke('cache_frontend_startup_appearance', { appearance: snapshot }).catch((error) => {
    // Browser/PWA clients and a frontend that is closing have no native host.
    cachedStartupAppearance = null
    console.warn('Unable to cache desktop startup appearance', error)
  })
}

function syncDesktopBackground(
  config: ThemeConfig,
  mode: ResolvedMode,
  vars: Record<string, string>,
  hasPaletteOverride: boolean,
) {
  const root = document.documentElement
  const background = config.desktopBackground
  const surface = resolveDesktopSurface(config, vars, hasPaletteOverride)

  root.setAttribute('data-rendering-mode', config.renderingMode ?? 'balanced')

  if (!hasTauriDesktopBridge()) {
    root.removeAttribute('data-desktop-background')
    root.removeAttribute('data-desktop-background-blur')
    root.style.removeProperty('--lumiverse-desktop-background')
    requestedNativeAppearance = null
    debugDesktopAppearance('browser-surface-cleared')
    return
  }

  cacheDesktopStartupAppearance(config, mode, vars, hasPaletteOverride)

  const desktopSurfaceColor = background?.color
    ? resolveDesktopSurfaceColor(config, vars, hasPaletteOverride)
    : null
  if (desktopSurfaceColor) {
    root.setAttribute('data-desktop-background', '')
    root.style.setProperty(
      '--lumiverse-desktop-background',
      surface.background,
    )
  } else {
    root.removeAttribute('data-desktop-background')
    root.style.removeProperty('--lumiverse-desktop-background')
  }

  if (surface.blur && root.getAttribute('data-desktop-surface') !== 'opaque') {
    root.setAttribute('data-desktop-background-blur', '')
  } else {
    root.removeAttribute('data-desktop-background-blur')
  }

  // A widget WebView owns only its transparent child surface. Never let its
  // independently hydrated theme reconfigure the primary window's material.
  if (new URLSearchParams(window.location.search).has('desktopWidgetExtension')) return

  const blur = surface.blur
  const dark = mode === 'dark'
  const blurIntensity = background?.blurIntensity ?? 'balanced'
  const surfaceMode = surface.surfaceMode
  const appearance = `${blur}:${dark}:${blurIntensity}:${surfaceMode}`

  if (appearance === requestedNativeAppearance) {
    debugDesktopAppearance('native-effect-unchanged', { blur, dark })
    return
  }
  requestedNativeAppearance = appearance
  debugDesktopAppearance('native-effect-requested', { blur, dark, blurIntensity })

  // Tauri IPC completion is asynchronous. Queue requests so a slow "enable"
  // response can never apply its material after a later "disable" request.
  nativeAppearanceQueue = nativeAppearanceQueue
    .catch(() => undefined)
    .then(async () => {
      if (requestedNativeAppearance !== appearance) return

      try {
        const status = await invoke<{ surfaceMode: DesktopSurfaceMode; restartRequired: boolean } | null>(
          'configure_frontend_appearance', { blur, dark, blurIntensity, surfaceMode },
        )
        // Older desktop hosts return null. New hosts report the surface that
        // was actually created; a reload cannot change its native flags.
        if (status) {
          root.setAttribute('data-desktop-surface', status.surfaceMode)
          root.toggleAttribute('data-desktop-surface-restart', status.restartRequired)
          if (status.surfaceMode === 'opaque') root.removeAttribute('data-desktop-background-blur')
        }
        debugDesktopAppearance('native-effect-applied', { blur, dark, blurIntensity })
      } catch (error) {
        // Permit the next theme application to retry if the native window was
        // not ready yet or its effects could not be updated.
        if (requestedNativeAppearance === appearance) requestedNativeAppearance = null
        debugDesktopAppearance('native-effect-failed', { blur, dark, blurIntensity, error: String(error) })
        console.warn('Unable to configure native frontend appearance', error)
      }
    })
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

const GLASS_COLOR_KEYS = new Set([
  '--lumiverse-bg', '--lumiverse-bg-elevated', '--lumiverse-bg-hover',
  '--lumiverse-surface', '--lumiverse-surface-raised', '--lumiverse-surface-hover',
  '--lcs-glass-bg', '--lcs-glass-bg-hover', '--lcs-glass-border', '--lcs-glass-border-hover',
])

export function buildResolvedThemeVars(
  theme: ThemeConfig | null,
  characterThemeOverlay: CharacterThemeOverlay | null,
  extensionThemeOverrides: ReturnType<typeof useStore.getState>['extensionThemeOverrides'],
  mutedExtensionThemes: ReturnType<typeof useStore.getState>['mutedExtensionThemes'],
  modeOverride?: ResolvedMode,
  deviceControls: ThemeControls | null = null,
): { config: ThemeConfig; mode: ResolvedMode; vars: Record<string, string>; hasOverrides: boolean; hasPaletteOverride: boolean } {
  const config = resolveDeviceTheme(theme, deviceControls)
  const mode = modeOverride ?? resolveMode(config)

  // Filter out overrides whose extension has been muted by the user in the
  // Theme tab. Muted overrides stay in the store (so re-enabling restores
  // them instantly) but must not contribute to the rendered CSS vars.
  const activeOverrides = Object.values(extensionThemeOverrides).filter(
    (o) => !mutedExtensionThemes[o.extensionId]
  )
  const hasOverrides = activeOverrides.length > 0
  const activeCharacterPalette = config.characterAware && !hasOverrides
    ? characterThemeOverlay
    : null
  const hasPaletteOverride = activeCharacterPalette !== null
    || activeOverrides.some((override) => !!override.paletteAccent)

  // Check if any extension provides a full theme-sized override (e.g. via
  // applyPalette). Even then, still layer it on top of the user's resolved
  // theme so omitted preference-owned tokens (glass blur, radii, fonts,
  // scaling) keep their current values instead of falling back to CSS
  // defaults.
  let fullThemeVars: Record<string, string> | null = null
  for (const override of activeOverrides) {
    if (override.paletteAccent) continue

    const modeVars = override.variablesByMode?.[mode]
    if (modeVars && Object.keys(modeVars).length >= FULL_THEME_MIN_KEYS) {
      fullThemeVars = { ...modeVars, ...override.variables }
    } else if (Object.keys(override.variables).length >= FULL_THEME_MIN_KEYS) {
      fullThemeVars = { ...override.variables }
      if (modeVars) Object.assign(fullThemeVars, modeVars)
    }
  }

  const effectiveConfig = activeCharacterPalette
    ? {
        ...config,
        accent: activeCharacterPalette.accent,
        baseColorsByMode: {
          ...config.baseColorsByMode,
          dark: { ...config.baseColorsByMode?.dark, ...activeCharacterPalette.baseColors },
          light: { ...config.baseColorsByMode?.light, ...activeCharacterPalette.baseColorsLight },
        },
      }
    : config

  const baseVars = generateThemeVariables(effectiveConfig, mode)
  let controlVars = baseVars
  // Device preferences own geometry and glass opacity; extensions still own palette colors.
  const preserveDeviceControls = (vars: Record<string, string>) => {
    if (deviceControls) {
      for (const key of Object.keys(controlVars)) {
        if (GLASS_COLOR_KEYS.has(key)) {
          vars[key] = withPreservedAlpha(vars[key], controlVars[key]) ?? vars[key]
        } else if (key.startsWith('--lumiverse-radius') || key.startsWith('--lcs-radius')
          || key.startsWith('--lcs-glass-') || key === '--lumiverse-font-scale' || key === '--lumiverse-ui-scale') {
          vars[key] = controlVars[key]
        }
      }
    }
    return vars
  }

  if (fullThemeVars) {
    return {
      config,
      mode,
      vars: preserveDeviceControls({
        ...baseVars,
        ...fullThemeVars,
      }),
      hasOverrides: true,
      hasPaletteOverride,
    }
  }

  // Partial overrides: generate the user's base theme, then layer on the
  // extension's handful of tweaks.
  const vars = { ...baseVars }
  for (const override of activeOverrides) {
    if (override.paletteAccent) {
      controlVars = generateThemeVariables({ ...effectiveConfig, accent: override.paletteAccent }, mode)
      Object.assign(vars, controlVars)
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

  return { config: effectiveConfig, mode, vars: preserveDeviceControls(vars), hasOverrides, hasPaletteOverride }
}

export function useThemeApplicator() {
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const deviceControls = useDeviceThemeControls(activeDeviceThemeControls)
  const characterThemeOverlay = useStore((s) => s.characterThemeOverlay)
  const extensionThemeOverrides = useStore((s) => s.extensionThemeOverrides)
  const mutedExtensionThemes = useStore((s) => s.mutedExtensionThemes)
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

  // Apply dimensions before paint; the resize notification below lets portal
  // positioning and other geometry consumers update against the new scale.
  useLayoutEffect(() => {
    const root = document.documentElement
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)')

    const applyResolvedTheme = (modeOverride?: ResolvedMode) => {
      const { config, mode, vars, hasOverrides, hasPaletteOverride } = buildResolvedThemeVars(theme, characterThemeOverlay, extensionThemeOverrides, mutedExtensionThemes, modeOverride, deviceControls)
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
      broadcastThemeToParent(mode, vars)
      syncThemeColorMeta(vars)
      syncDesktopBackground(config, mode, vars, hasPaletteOverride)

      window.dispatchEvent(new Event('resize'))

      applyGlassAttributes(config, motionMq.matches)

      return { config }
    }

    const initial = applyResolvedTheme()
    const config = initial?.config ?? (theme ?? DEFAULT_THEME)

    const updateGlass = () => {
      const latest = buildResolvedThemeVars(theme, characterThemeOverlay, extensionThemeOverrides, mutedExtensionThemes, undefined, deviceControls)
      applyGlassAttributes(latest.config, motionMq.matches)
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
  }, [theme, characterThemeOverlay, extensionThemeOverrides, mutedExtensionThemes, deviceControls])
}
