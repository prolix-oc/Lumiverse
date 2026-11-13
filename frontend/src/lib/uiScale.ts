export const MIN_UI_SCALE = 0.5
export const MAX_UI_SCALE = 1.5

/** Saved/imported settings must stay within the range offered by the UI. */
export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value))
}

export function getUiScale(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 1
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export const readUiScale = getUiScale

export function renderedPxToLayoutPx(renderedPx: number, scale = getUiScale()): number {
  const uiScale = validScale(scale)
  return uiScale === 1 ? renderedPx : renderedPx / uiScale
}

export interface LayoutSize { width: number; height: number }
export interface LayoutDelta { x: number; y: number }
export interface LayoutRect extends LayoutSize { x: number; y: number }

function validScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Convert rendered/client pixels to zoom-layer layout pixels using an explicit scale. */
export function toLayoutPx(renderedPx: number, scale = getUiScale()): number {
  return finite(renderedPx) / validScale(scale)
}

export function toLayoutSize(size: Partial<LayoutSize> | null | undefined, scale = getUiScale()): LayoutSize {
  return { width: Math.max(0, toLayoutPx(finite(size?.width), scale)), height: Math.max(0, toLayoutPx(finite(size?.height), scale)) }
}

export function toLayoutDelta(dx: number, dy: number, scale = getUiScale()): LayoutDelta {
  return { x: toLayoutPx(dx, scale), y: toLayoutPx(dy, scale) }
}

export function layoutViewportSize(
  fallback: LayoutSize = { width: 1440, height: 900 },
  scale = getUiScale(),
  view: Pick<Window, 'innerWidth' | 'innerHeight'> | undefined = typeof window === 'undefined' ? undefined : window,
): LayoutSize {
  return view ? toLayoutSize({ width: view.innerWidth, height: view.innerHeight }, scale) : { ...fallback }
}

export function layoutElementRect(element: { getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> } | null | undefined, scale = getUiScale()): LayoutRect {
  if (!element) return { x: 0, y: 0, width: 0, height: 0 }
  const rect = element.getBoundingClientRect()
  return { x: toLayoutPx(rect.left, scale), y: toLayoutPx(rect.top, scale), ...toLayoutSize(rect, scale) }
}

export function layoutElementSize(element: { getBoundingClientRect(): Pick<DOMRect, 'width' | 'height'> } | null | undefined, fallback: LayoutSize, scale = getUiScale()): LayoutSize {
  return element ? toLayoutSize(element.getBoundingClientRect(), scale) : fallback
}

export function measureLayoutHeight(element: Element | null): number {
  if (!(element instanceof HTMLElement)) return 0

  const layoutHeight = Math.max(
    element.offsetHeight,
    element.scrollHeight,
    element.clientHeight,
  )

  if (layoutHeight > 0) return layoutHeight
  return renderedPxToLayoutPx(element.getBoundingClientRect().height)
}
