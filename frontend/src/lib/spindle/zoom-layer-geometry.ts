import { getUiScale as readUiScale } from '@/lib/uiScale'

export interface LayoutSize {
  width: number
  height: number
}

export interface LayoutRect extends LayoutSize {
  x: number
  y: number
}

export type ResizeEdge =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

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

export const DEFAULT_LAYOUT_VIEWPORT: LayoutSize = { width: 1440, height: 900 }

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const positive = (value: unknown, fallback = 0): number => Math.max(0, finite(value, fallback))

const scale = (value: unknown): number => {
  const normalized = finite(value, 1)
  return normalized > 0 ? normalized : 1
}

const edgeHas = (edge: ResizeEdge, direction: 'top' | 'right' | 'bottom' | 'left'): boolean =>
  edge === direction || edge.startsWith(`${direction}-`) || edge.endsWith(`-${direction}`)

export function getUiScale(): number {
  try {
    return scale(readUiScale())
  } catch {
    return 1
  }
}

export function toLayoutPx(renderedPx: number, uiScale = getUiScale()): number {
  const normalizedScale = scale(uiScale)
  return finite(renderedPx) / normalizedScale
}

export function toLayoutSize(size: Partial<LayoutSize> | null | undefined, uiScale = getUiScale()): LayoutSize {
  return {
    width: toLayoutPx(positive(size?.width), uiScale),
    height: toLayoutPx(positive(size?.height), uiScale),
  }
}

export function toLayoutDelta(dx: number, dy: number, uiScale = getUiScale()): { x: number; y: number } {
  return { x: toLayoutPx(dx, uiScale), y: toLayoutPx(dy, uiScale) }
}

export function layoutViewportSize(
  fallback: LayoutSize = DEFAULT_LAYOUT_VIEWPORT,
  uiScale = getUiScale(),
  view: Pick<Window, 'innerWidth' | 'innerHeight'> | undefined = typeof window === 'undefined' ? undefined : window,
): LayoutSize {
  return view ? toLayoutSize({ width: view.innerWidth, height: view.innerHeight }, uiScale) : { ...fallback }
}

export function layoutElementRect(
  element: { getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> } | null | undefined,
  uiScale = getUiScale(),
): LayoutRect {
  if (!element) return { x: 0, y: 0, width: 0, height: 0 }
  const rect = element.getBoundingClientRect()
  return {
    x: toLayoutPx(rect.left, uiScale),
    y: toLayoutPx(rect.top, uiScale),
    width: toLayoutPx(rect.width, uiScale),
    height: toLayoutPx(rect.height, uiScale),
  }
}

export function clampLayoutRect(
  rect: LayoutRect,
  bounds: LayoutRect,
  options?: { minSize?: number | Partial<LayoutSize> },
): LayoutRect {
  const min = limits(options?.minSize, 0)
  const safeBounds = normalize(bounds)
  const width = Math.min(Math.max(positive(rect.width), min.width), Math.max(min.width, safeBounds.width))
  const height = Math.min(Math.max(positive(rect.height), min.height), Math.max(min.height, safeBounds.height))
  return {
    x: Math.min(Math.max(finite(rect.x), safeBounds.x), safeBounds.x + Math.max(0, safeBounds.width - width)),
    y: Math.min(Math.max(finite(rect.y), safeBounds.y), safeBounds.y + Math.max(0, safeBounds.height - height)),
    width,
    height,
  }
}

function normalize(rect: LayoutRect): LayoutRect {
  return { x: finite(rect.x), y: finite(rect.y), width: positive(rect.width), height: positive(rect.height) }
}

function limits(value: number | Partial<LayoutSize> | undefined, fallback: number): LayoutSize {
  return typeof value === 'number'
    ? { width: positive(value), height: positive(value) }
    : { width: positive(value?.width, fallback), height: positive(value?.height, fallback) }
}

function bound(rect: LayoutRect, options: ResizeControllerOptions): LayoutRect {
  const min = limits(options.minSize, 0)
  const max = limits(options.maxSize, Number.POSITIVE_INFINITY)
  let next = normalize({
    ...rect,
    width: Math.min(Math.max(rect.width, min.width), Math.max(min.width, max.width)),
    height: Math.min(Math.max(rect.height, min.height), Math.max(min.height, max.height)),
  })
  const bounds = typeof options.bounds === 'function' ? options.bounds() : options.bounds
  if (!bounds) return next
  const safeBounds = normalize(bounds)
  next = { ...next, width: Math.min(next.width, safeBounds.width), height: Math.min(next.height, safeBounds.height) }
  return {
    ...next,
    x: Math.min(Math.max(next.x, safeBounds.x), safeBounds.x + safeBounds.width - next.width),
    y: Math.min(Math.max(next.y, safeBounds.y), safeBounds.y + safeBounds.height - next.height),
  }
}

function resized(start: LayoutRect, edge: ResizeEdge, dx: number, dy: number, options: ResizeControllerOptions): LayoutRect {
  const left = edgeHas(edge, 'left')
  const right = edgeHas(edge, 'right')
  const top = edgeHas(edge, 'top')
  const bottom = edgeHas(edge, 'bottom')
  let next = { ...start }
  if (left) { next.x += dx; next.width -= dx }
  if (right) next.width += dx
  if (top) { next.y += dy; next.height -= dy }
  if (bottom) next.height += dy

  const ratio = typeof options.aspectLock === 'number'
    ? options.aspectLock
    : options.aspectLock ? start.width / Math.max(1, start.height) : 0
  if (Number.isFinite(ratio) && ratio > 0) {
    if (left || right) next.height = next.width / ratio
    else next.width = next.height * ratio
    if (left) next.x = start.x + start.width - next.width
    if (top) next.y = start.y + start.height - next.height
  }

  const bounded = bound(next, options)
  const bounds = typeof options.bounds === 'function' ? options.bounds() : options.bounds
  if (right && !left) {
    bounded.x = start.x
    if (bounds) bounded.width = Math.min(bounded.width, Math.max(0, bounds.x + bounds.width - start.x))
  }
  if (bottom && !top) {
    bounded.y = start.y
    if (bounds) bounded.height = Math.min(bounded.height, Math.max(0, bounds.y + bounds.height - start.y))
  }
  return bounded
}

export function createResizeController(options: ResizeControllerOptions): () => void {
  const target = options.pointerTarget ?? (typeof window === 'undefined' ? options.element : window)
  let disposed = false
  let pointerId: number | undefined
  let startX = 0
  let startY = 0
  let startRect: LayoutRect | undefined
  let latest: LayoutRect | undefined
  let capturedScale = 1

  const remove = () => {
    pointerId = undefined
    startRect = undefined
    latest = undefined
    target.removeEventListener('pointermove', move as EventListener)
    target.removeEventListener('pointerup', up as EventListener)
    target.removeEventListener('pointercancel', cancel as EventListener)
  }
  const move = (event: PointerEvent) => {
    if (disposed || pointerId !== event.pointerId || !startRect) return
    latest = resized(startRect, options.edge, toLayoutPx(event.clientX - startX, capturedScale), toLayoutPx(event.clientY - startY, capturedScale), options)
    options.onChange?.(latest)
  }
  const up = (event: PointerEvent) => {
    if (disposed || pointerId !== event.pointerId) return
    const committed = latest
    remove()
    if (committed) options.onCommit?.(committed)
  }
  const cancel = (event: PointerEvent) => {
    if (!disposed && pointerId === event.pointerId) remove()
  }
  const down = (event: PointerEvent) => {
    if (disposed) return
    remove()
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    startRect = normalize(options.getRect())
    latest = startRect
    capturedScale = scale(typeof options.uiScale === 'function' ? options.uiScale() : options.uiScale ?? getUiScale())
    target.addEventListener('pointermove', move as EventListener)
    target.addEventListener('pointerup', up as EventListener)
    target.addEventListener('pointercancel', cancel as EventListener)
  }

  options.element.addEventListener('pointerdown', down as EventListener)
  return () => {
    if (disposed) return
    disposed = true
    options.element.removeEventListener('pointerdown', down as EventListener)
    remove()
  }
}
