import type { CSSProperties } from 'react'

export const FLOAT_WIDGET_VIEWPORT_PADDING = 12

export const FULLSCREEN_FLOAT_WIDGET_STYLE = {
  left: 0,
  top: 0,
  width: 'var(--app-scaled-viewport-width, calc(100vw / var(--lumiverse-ui-scale, 1)))',
  height: 'var(--app-scaled-viewport-height, calc(100vh / var(--lumiverse-ui-scale, 1)))',
} satisfies CSSProperties

export function resolveFloatWidgetSize(
  mobile: boolean,
  requestedSize: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  if (!mobile) return requestedSize

  return {
    width: Math.max(1, Math.min(requestedSize.width, viewport.width - FLOAT_WIDGET_VIEWPORT_PADDING * 2)),
    height: Math.max(1, Math.min(requestedSize.height, viewport.height - FLOAT_WIDGET_VIEWPORT_PADDING * 2)),
  }
}

export function resolveFloatWidgetStyle(
  fullscreen: boolean,
  position: { x: number; y: number },
  size: { width: number; height: number },
): CSSProperties {
  if (fullscreen) return FULLSCREEN_FLOAT_WIDGET_STYLE

  return {
    left: 0,
    top: 0,
    transform: floatWidgetTransform(position),
    width: size.width,
    height: size.height,
  }
}

export function floatWidgetTransform(position: { x: number; y: number }): string {
  return `translate3d(${position.x}px, ${position.y}px, 0)`
}
