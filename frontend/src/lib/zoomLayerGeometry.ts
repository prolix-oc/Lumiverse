import { getUiScale, layoutElementSize, layoutViewportSize, renderedPxToLayoutPx, toLayoutDelta, toLayoutSize, type LayoutRect, type LayoutSize } from './uiScale'

export type ResizeEdge = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type { LayoutRect, LayoutSize }
export { getUiScale, layoutElementSize, layoutViewportSize, toLayoutDelta, toLayoutSize }
export interface ResizeControllerOptions {
  element: EventTarget
  edge: ResizeEdge
  getRect: () => LayoutRect
  onChange?: (rect: LayoutRect) => void
  onCommit?: (rect: LayoutRect) => void
  bounds?: LayoutRect | (() => LayoutRect | undefined)
  minSize?: number | Partial<LayoutSize>
  maxSize?: number | Partial<LayoutSize>
  aspectLock?: boolean | number
  snap?: boolean | number | { grid?: number; threshold?: number }
  pointerTarget?: EventTarget
  uiScale?: number | (() => number)
}

const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const positive = (value: unknown, fallback = 0) => Math.max(0, finite(value, fallback))
const edgeHas = (edge: ResizeEdge, side: string) => edge === side || edge.startsWith(`${side}-`) || edge.endsWith(`-${side}`)
const limits = (value: number | Partial<LayoutSize> | undefined, fallback: number): LayoutSize => typeof value === 'number' ? { width: positive(value), height: positive(value) } : { width: positive(value?.width, fallback), height: positive(value?.height, fallback) }
const normalize = (rect: LayoutRect): LayoutRect => ({ x: finite(rect.x), y: finite(rect.y), width: positive(rect.width), height: positive(rect.height) })

export function clampLayoutRect(rect: LayoutRect, bounds: LayoutRect, options: { minSize?: number | Partial<LayoutSize> } = {}): LayoutRect {
  const safe = normalize(bounds); const min = limits(options.minSize, 0)
  const width = Math.min(Math.max(positive(rect.width), min.width), Math.max(min.width, safe.width))
  const height = Math.min(Math.max(positive(rect.height), min.height), Math.max(min.height, safe.height))
  return { x: Math.min(Math.max(finite(rect.x), safe.x), safe.x + Math.max(0, safe.width - width)), y: Math.min(Math.max(finite(rect.y), safe.y), safe.y + Math.max(0, safe.height - height)), width, height }
}

function snapped(value: number, setting: ResizeControllerOptions['snap']): number {
  const grid = typeof setting === 'number' ? setting : typeof setting === 'object' ? setting.grid ?? 0 : 0
  return grid > 0 ? Math.round(value / grid) * grid : value
}

function resized(start: LayoutRect, edge: ResizeEdge, dx: number, dy: number, options: ResizeControllerOptions): LayoutRect {
  const left = edgeHas(edge, 'left'), right = edgeHas(edge, 'right'), top = edgeHas(edge, 'top'), bottom = edgeHas(edge, 'bottom')
  let next = { ...start }
  if (left) { next.x += dx; next.width -= dx }; if (right) next.width += dx
  if (top) { next.y += dy; next.height -= dy }; if (bottom) next.height += dy
  const ratio = typeof options.aspectLock === 'number' ? options.aspectLock : options.aspectLock ? start.width / Math.max(1, start.height) : 0
  if (ratio > 0 && Number.isFinite(ratio)) { if (left || right) next.height = next.width / ratio; else next.width = next.height * ratio; if (left) next.x = start.x + start.width - next.width; if (top) next.y = start.y + start.height - next.height }
  const min = limits(options.minSize, 0), max = limits(options.maxSize, Number.POSITIVE_INFINITY)
  next.width = Math.min(Math.max(snapped(next.width, options.snap), min.width), Math.max(min.width, max.width))
  next.height = Math.min(Math.max(snapped(next.height, options.snap), min.height), Math.max(min.height, max.height))
  if (right && !left) next.x = start.x; if (bottom && !top) next.y = start.y
  const bounds = typeof options.bounds === 'function' ? options.bounds() : options.bounds
  return bounds ? clampLayoutRect(next, bounds, { minSize: options.minSize }) : normalize(next)
}

export function createResizeController(options: ResizeControllerOptions): () => void {
  const target = options.pointerTarget ?? (typeof window === 'undefined' ? options.element : window)
  let disposed = false; let pointerId: number | undefined; let startX = 0; let startY = 0; let startRect: LayoutRect | undefined; let latest: LayoutRect | undefined; let scale = 1
  const remove = () => { pointerId = undefined; startRect = undefined; latest = undefined; target.removeEventListener('pointermove', move as EventListener); target.removeEventListener('pointerup', up as EventListener); target.removeEventListener('pointercancel', cancel as EventListener) }
  const move = (event: PointerEvent) => { if (disposed || event.pointerId !== pointerId || !startRect) return; latest = resized(startRect, options.edge, renderedPxToLayoutPx(event.clientX - startX, scale), renderedPxToLayoutPx(event.clientY - startY, scale), options); options.onChange?.(latest) }
  const up = (event: PointerEvent) => { if (event.pointerId !== pointerId) return; const committed = latest; remove(); if (committed) options.onCommit?.(committed) }
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) remove() }
  const down = (event: PointerEvent) => { if (disposed) return; remove(); pointerId = event.pointerId; startX = event.clientX; startY = event.clientY; startRect = normalize(options.getRect()); latest = startRect; scale = Math.max(0.0001, finite(typeof options.uiScale === 'function' ? options.uiScale() : options.uiScale, getUiScale())); target.addEventListener('pointermove', move as EventListener); target.addEventListener('pointerup', up as EventListener); target.addEventListener('pointercancel', cancel as EventListener) }
  options.element.addEventListener('pointerdown', down as EventListener)
  return () => { if (disposed) return; disposed = true; options.element.removeEventListener('pointerdown', down as EventListener); remove() }
}
