import { getUiScale } from '@/lib/uiScale'
import { isMobileViewportOrDevice } from '@/lib/mobile'

export interface SpindleModalGeometryOptions {
  width?: number
  maxHeight?: number
}

export interface SpindleModalViewport {
  width: number
  height: number
  uiScale: number
  mobile?: boolean
}

export interface SpindleModalGeometry {
  width: number
  maxHeight: number
}

export const DEFAULT_SPINDLE_MODAL_WIDTH = 420
export const DEFAULT_SPINDLE_MODAL_MAX_HEIGHT = 520
export const SPINDLE_MODAL_VIEWPORT_GUTTER = 40

function positiveFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function validScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * Resolve a modal's layout-space bounds inside Lumiverse's body zoom layer.
 *
 * `viewport.width` / `height` are rendered viewport pixels. Spindle modal DOM
 * lives under the scaled body, so viewport limits must be converted back to
 * layout pixels before clamping extension-requested dimensions. Otherwise a
 * large modal is clamped to the rendered viewport first and then scaled again.
 */
export function resolveSpindleModalGeometry(
  options: SpindleModalGeometryOptions | undefined,
  viewport: SpindleModalViewport,
): SpindleModalGeometry {
  const uiScale = validScale(viewport.uiScale)
  const gutter = viewport.mobile ? 24 : SPINDLE_MODAL_VIEWPORT_GUTTER
  const availableWidth = Math.max(0, (positiveFinite(viewport.width, 0) - gutter) / uiScale)
  const availableHeight = Math.max(0, (positiveFinite(viewport.height, 0) - gutter) / uiScale)
  // Mobile dialogs keep their requested footprint while their controls scale.
  const sizeScale = viewport.mobile ? uiScale : 1

  return {
    width: Math.min(positiveFinite(options?.width, DEFAULT_SPINDLE_MODAL_WIDTH) / sizeScale, availableWidth),
    maxHeight: Math.min(positiveFinite(options?.maxHeight, DEFAULT_SPINDLE_MODAL_MAX_HEIGHT) / sizeScale, availableHeight),
  }
}

function readViewportPixelVar(name: string, fallback: number): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  // Before viewport sync runs the CSS fallback is a viewport unit (e.g. 100dvh),
  // which parseFloat would incorrectly interpret as 100px. Only trust resolved px.
  if (!/^-?(?:\d+\.?\d*|\.\d+)px$/i.test(raw)) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveCurrentSpindleModalGeometry(
  options?: SpindleModalGeometryOptions,
): SpindleModalGeometry {
  const fallbackWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const fallbackHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  return resolveSpindleModalGeometry(options, {
    width: readViewportPixelVar('--app-viewport-width', fallbackWidth),
    height: readViewportPixelVar('--app-viewport-height', fallbackHeight),
    uiScale: getUiScale(),
    mobile: isMobileViewportOrDevice(),
  })
}
