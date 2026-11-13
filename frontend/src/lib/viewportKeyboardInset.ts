interface ComputeViewportKeyboardInsetOptions {
  fullHeight: number
  viewportHeight: number
  offsetTop: number
  keyboardActive: boolean
  ignoreOffsetTop?: boolean
  keyboardMinInset?: number
  accessoryMinInset?: number
}

export function computeViewportKeyboardInset({
  fullHeight,
  viewportHeight,
  offsetTop,
  keyboardActive,
  ignoreOffsetTop = false,
  keyboardMinInset = 80,
  accessoryMinInset = keyboardMinInset,
}: ComputeViewportKeyboardInsetOptions): number {
  const rawInset = Math.max(0, Math.round(
    fullHeight - viewportHeight - (ignoreOffsetTop ? 0 : offsetTop),
  ))

  if (!keyboardActive) return 0
  if (rawInset >= keyboardMinInset) return rawInset
  if (rawInset >= accessoryMinInset) return rawInset
  return 0
}

/** Standalone iOS suppresses page panning and can retain stale viewport
 * readings after blur. Use the same focus-gated clearance as the composer,
 * while preserving the real visual viewport for pinch zoom and other hosts. */
export function computeVisibleViewport({
  fullHeight,
  viewportHeight,
  offsetTop,
  scale,
  keyboardInsetBottom,
  isIOSStandaloneClient,
}: {
  fullHeight: number
  viewportHeight: number
  offsetTop: number
  scale: number
  keyboardInsetBottom: number
  isIOSStandaloneClient: boolean
}): { height: number; offsetTop: number } {
  if (isIOSStandaloneClient && Math.abs(scale - 1) <= 0.01) {
    return { height: Math.max(0, fullHeight - keyboardInsetBottom), offsetTop: 0 }
  }
  return { height: viewportHeight, offsetTop }
}
