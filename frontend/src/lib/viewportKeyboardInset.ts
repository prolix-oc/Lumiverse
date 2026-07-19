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
