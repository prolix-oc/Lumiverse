/** Widths are layout pixels, independent of the user's UI zoom. */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const max = Math.max(0, Math.min(viewportWidth * 0.8, viewportWidth - 64))
  return Math.round(Math.min(max, Math.max(Math.min(280, max), Number.isFinite(width) ? width : 420)))
}

export function drawerWidthFromDelta(start: number, delta: number, side: 'left' | 'right', scale: number, viewport: number): number {
  return clampDrawerWidth(start + delta * (side === 'right' ? -1 : 1) / scale, viewport)
}
