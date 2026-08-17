export type RotatedResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export interface RectLike { x: number; y: number; width: number; height: number }
export interface Vec2 { dx: number; dy: number }
export interface RectBounds extends RectLike {}
export interface ResizeRectOptions { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number; aspectRatio?: number; snap?: number; bounds?: RectBounds }
const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
export function isUnrotated(rotationDeg: number): boolean { return !Number.isFinite(rotationDeg) || rotationDeg % 360 === 0 }
export function toLocalDelta(dx: number, dy: number, rotationDeg: number): Vec2 { if (isUnrotated(rotationDeg)) return { dx, dy }; const theta = rotationDeg * Math.PI / 180; const c = Math.cos(theta), s = Math.sin(theta); return { dx: dx * c + dy * s, dy: -dx * s + dy * c } }
export function resizeCentreShift(start: Pick<RectLike, 'width' | 'height'>, next: Pick<RectLike, 'width' | 'height'>, handle: RotatedResizeHandle): Vec2 { const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0; const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0; return { dx: hx * (next.width - start.width) / 2, dy: hy * (next.height - start.height) / 2 } }
export function rotatedAnchorShift(start: Pick<RectLike, 'width' | 'height'>, next: Pick<RectLike, 'width' | 'height'>, handle: RotatedResizeHandle, rotationDeg: number): Vec2 { if (isUnrotated(rotationDeg)) return { dx: 0, dy: 0 }; const u = resizeCentreShift(start, next, handle); const theta = rotationDeg * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta); return { dx: c * u.dx - s * u.dy - u.dx, dy: s * u.dx + c * u.dy - u.dy } }
export function compensateRotatedAnchor<T extends RectLike>(start: Pick<RectLike, 'width' | 'height'>, next: T, handle: RotatedResizeHandle, rotationDeg: number): T { if (isUnrotated(rotationDeg)) return next; const shift = rotatedAnchorShift(start, next, handle, rotationDeg); return { ...next, x: next.x + shift.dx, y: next.y + shift.dy } }
export function normalizeRect(rect: RectLike): RectLike { return { x: finite(rect.x), y: finite(rect.y), width: Math.max(0, finite(rect.width)), height: Math.max(0, finite(rect.height)) } }
export function clampRectToBounds(rect: RectLike, bounds: RectBounds): RectLike { const source = normalizeRect(rect), limit = normalizeRect(bounds); const width = Math.min(source.width, limit.width), height = Math.min(source.height, limit.height); return { x: clamp(source.x, limit.x, limit.x + limit.width - width), y: clamp(source.y, limit.y, limit.y + limit.height - height), width, height } }
export function resizeRectFromHandle(rect: RectLike, handle: RotatedResizeHandle, delta: Vec2 | { x: number; y: number }, options: ResizeRectOptions = {}): RectLike {
  const source = normalizeRect(rect), dx = finite('dx' in delta ? delta.dx : delta.x), dy = finite('dy' in delta ? delta.dy : delta.y), west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s')
  const minW = Math.max(0, finite(options.minWidth)), minH = Math.max(0, finite(options.minHeight)), maxW = Math.max(minW, finite(options.maxWidth, Infinity)), maxH = Math.max(minH, finite(options.maxHeight, Infinity)), ratio = finite(options.aspectRatio), grid = Math.max(0, finite(options.snap))
  const quantize = (value: number, min: number, max: number) => clamp(grid > 0 ? Math.round(value / grid) * grid : value, min, max)
  const wd = west ? -dx : east ? dx : 0, hd = north ? -dy : south ? dy : 0
  let width = quantize(source.width + wd, minW, maxW), height = quantize(source.height + hd, minH, maxH)
  if (ratio > 0 && (wd || hd)) { if (wd) { height = quantize(width / ratio, minH, maxH); width = quantize(height * ratio, minW, maxW) } else { width = quantize(height * ratio, minW, maxW); height = quantize(width / ratio, minH, maxH) } }
  let x = west ? source.x + source.width - width : source.x, y = north ? source.y + source.height - height : source.y
  if (ratio > 0 && wd && !hd) y = source.y + (source.height - height) / 2
  if (ratio > 0 && hd && !wd) x = source.x + (source.width - width) / 2
  if (options.bounds && ratio > 0) {
    const limit = normalizeRect(options.bounds)
    const scale = Math.min(1, limit.width / Math.max(1, width), limit.height / Math.max(1, height))
    if (scale < 1) { width = quantize(width * scale, minW, maxW); height = quantize(width / ratio, minH, maxH); x = west ? source.x + source.width - width : source.x; y = north ? source.y + source.height - height : source.y }
  }
  const next = { x, y, width, height }; return options.bounds ? clampRectToBounds(next, options.bounds) : next
}
/** Screen-space resize: on-screen outward drag grows the box. Do not pre-rotate via toLocalDelta — at ±180° that flips dx/dy and shrinks. */
export function resizeRectFromScreenDelta(rect: RectLike, handle: RotatedResizeHandle, delta: Vec2 | { x: number; y: number }, rotationDeg = 0, options: ResizeRectOptions = {}): RectLike { return compensateRotatedAnchor(rect, resizeRectFromHandle(rect, handle, delta, options), handle, rotationDeg) }
export const resizeRect = resizeRectFromHandle
